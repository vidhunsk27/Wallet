const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const puppeteer = require('puppeteer');
const tesseract = require('tesseract.js');

// --- FIREBASE IMPORTS ---
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// SECURE API KEY INITIALIZATION
const apiKey = process.env.GEMINI_API_KEY || "YOUR_API_KEY_HERE";
const genAI = new GoogleGenerativeAI(apiKey);

// --- FIREBASE INITIALIZATION ---
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }
} catch (error) {
    console.error("Firebase config error: Could not load service account credentials.");
    process.exit(1);
}

try {
    initializeApp({ credential: cert(serviceAccount) });
    console.log("Firebase initialized successfully!");
} catch (error) {
    console.error("Failed to initialize Firebase app:", error);
    process.exit(1);
}

const db = getFirestore();

// ==========================================
//           CORE DATABASE ROUTES
// ==========================================

app.get('/api/get-transactions', async (req, res) => {
    try {
        const snapshot = await db.collection('transactions').get();
        res.status(200).json(snapshot.docs.map(doc => doc.data()));
    } catch (error) { res.status(500).json({ error: 'Failed to fetch' }); }
});

app.post('/api/add-transaction', async (req, res) => {
    try {
        await db.collection('transactions').doc(req.body.id).set(req.body);
        res.status(201).json({ message: 'Added successfully' });
    } catch (error) { res.status(500).json({ error: 'Failed to add' }); }
});

app.delete('/api/delete-transaction/:id', async (req, res) => {
    try {
        await db.collection('transactions').doc(req.params.id).delete();
        res.status(200).json({ message: 'Deleted' });
    } catch (error) { res.status(500).json({ error: 'Failed to delete' }); }
});

app.post('/api/sync-transactions', async (req, res) => {
    try {
        const transactions = req.body;
        const batch = db.batch();
        transactions.forEach(tx => {
            const docRef = db.collection('transactions').doc(tx.id);
            batch.set(docRef, tx);
        });
        await batch.commit();
        res.status(200).json({ message: 'Sync complete' });
    } catch (error) { res.status(500).json({ error: 'Failed to sync' }); }
});

app.get('/api/get-wishlist', async (req, res) => {
    try {
        const snapshot = await db.collection('wishlist').get();
        res.status(200).json(snapshot.docs.map(doc => doc.data()));
    } catch (error) { res.status(500).json({ error: 'Failed to fetch' }); }
});

app.post('/api/add-wishlist', async (req, res) => {
    try {
        await db.collection('wishlist').doc(req.body.id).set(req.body);
        res.status(201).json({ message: 'Added successfully' });
    } catch (error) { res.status(500).json({ error: 'Failed to add' }); }
});

app.delete('/api/delete-wishlist/:id', async (req, res) => {
    try {
        await db.collection('wishlist').doc(req.params.id).delete();
        res.status(200).json({ message: 'Deleted' });
    } catch (error) { res.status(500).json({ error: 'Failed to delete' }); }
});

app.post('/api/sync-wishlist', async (req, res) => {
    try {
        const items = req.body;
        const batch = db.batch();
        items.forEach(item => {
            const docRef = db.collection('wishlist').doc(item.id);
            batch.set(docRef, item);
        });
        await batch.commit();
        res.status(200).json({ message: 'Wishlist sync complete' });
    } catch (error) { res.status(500).json({ error: 'Failed to sync wishlist' }); }
});

// ==========================================
//             AI & TOOL ROUTES
// ==========================================

app.post('/api/jarvis-advice', async (req, res) => {
    try {
        const { transactions, monthlyBudget } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        
        const prompt = `You are a sharp, highly intelligent personal financial assistant. 
        Analyze these transactions (with pre-calculated totals): ${JSON.stringify(transactions)}. 
        The user's monthly budget is ₹${monthlyBudget}. 
        
        Provide a quick, conversational financial summary, followed by ONE highly actionable piece of advice. 
        
        STRICT RULES:
        1. Speak directly to the user in a cool, helpful tone.
        2. DO NOT use any markdown formatting (no asterisks, bolding, or hashes).
        3. Keep it to 3-4 short sentences total.
        4. Use normal line breaks to separate the summary from the advice.`;

        const result = await model.generateContent(prompt);
        res.status(200).json({ advice: result.response.text() });
    } catch (error) { res.status(500).json({ error: 'Failed to generate' }); }
});

app.post('/api/sms-webhook', async (req, res) => {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `Extract amount, merchant, date, and type (income/expense) from this bank SMS: "${req.body.smsText}". 
        Return ONLY a JSON object: {amount: number, merchant: string, date: "YYYY-MM-DD", type: string}. If invalid, return {"error":"invalid"}`;

        const result = await model.generateContent(prompt);
        const parsedData = JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim());

        if (parsedData.error) return res.status(400).json({ message: 'Invalid SMS' });

        const txId = String(Date.now());
        const txData = { id: txId, type: parsedData.type, amount: parsedData.amount, merchant: parsedData.merchant, account: 'UPI', category: 'Other', note: parsedData.merchant + " (SMS)", timestamp: Date.now(), isRecurring: false };
        await db.collection('transactions').doc(txId).set(txData);
        res.status(201).json({ message: 'Saved', data: txData });
    } catch (error) { res.status(500).json({ error: 'Webhook failed' }); }
});

app.post('/api/receipt-ocr', upload.single('receipt'), async (req, res) => {
    try {
        const { data: { text } } = await tesseract.recognize(req.file.buffer, 'eng');
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `Find total amount paid from this receipt text: "${text}". Return JSON format: { "total": number }`;
        const result = await model.generateContent(prompt);
        res.status(200).json(JSON.parse(result.response.text().replace(/```json/g, '').replace(/```/g, '').trim()));
    } catch (error) { res.status(500).json({ error: 'OCR failed' }); }
});

// ==========================================
//     HIGH-ACCURACY MULTI-ENGINE SCRAPER
// ==========================================

app.post('/api/scrape-price', async (req, res) => {
    let browser;
    try {
        browser = await puppeteer.launch({ 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] 
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Wait longer for heavy client-side scripts to run (like Flipkart Minutes react state)
        await page.goto(req.body.url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        const data = await page.evaluate(() => {
            let price = 0;
            let cleanTitle = document.querySelector('h1')?.innerText || document.title;
            cleanTitle = cleanTitle.split('|')[0].split('- Buy')[0].split('- Price')[0].trim();

            // Engine 1: Intercept Google Search metadata engine (JSON-LD)
            const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            for (const script of ldScripts) {
                try {
                    const parsed = JSON.parse(script.innerText);
                    const items = Array.isArray(parsed) ? parsed : [parsed];
                    for (const item of items) {
                        let target = null;
                        if (item['@type'] === 'Product') {
                            target = item;
                        } else if (item['@graph'] && Array.isArray(item['@graph'])) {
                            target = item['@graph'].find(g => g['@type'] === 'Product');
                        }

                        if (target && target.offers) {
                            let offers = Array.isArray(target.offers) ? target.offers : [target.offers];
                            for (let offer of offers) {
                                if (offer.price) {
                                    price = parseFloat(String(offer.price).replace(/[^\d.]/g, ''));
                                } else if (offer.lowPrice) {
                                    price = parseFloat(String(offer.lowPrice).replace(/[^\d.]/g, ''));
                                }
                                if (price > 0) break;
                            }
                            if (target.name) cleanTitle = target.name.split('|')[0].split('- Buy')[0].trim();
                        }
                    }
                    if (price > 0) break;
                } catch(e) {}
            }

            // Engine 2: Specific Priority Selectors (No broad text sweeps)
            if (price === 0) {
                const priceSelectors = [
                    '.a-price-whole', '._30jeq3', '.Nx9bqj', 
                    '._1V76Xq', '._25b18c', '[data-qa="product-price"]', 
                    '.price', '.product-price', '.final-price'
                ];
                for (const sel of priceSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.innerText) {
                        let extracted = parseFloat(el.innerText.replace(/[^\d.]/g, ''));
                        if (extracted > 0) { price = extracted; break; }
                    }
                }
            }

            const imgEl = document.querySelector('meta[property="og:image"]')?.content || document.querySelector('#landingImage, #imgTagWrapperId img, .a-dynamic-image, img[class*="v25dir"]')?.src;
            return { title: cleanTitle, price: price, imageUrl: imgEl || '' };
        });
        await browser.close();
        res.status(200).json(data);
    } catch (error) {
        if (browser) await browser.close();
        res.status(500).json({ error: 'Scraping failed' });
    }
});

// --- THE MAGIC BOOKMARKLET ROUTE (V4 - MULTI-ENGINE INTERCEPT) ---
app.get('/api/bookmark', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.send("No URL provided.");

    let browser;
    try {
        browser = await puppeteer.launch({ 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] 
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 3000));

        const data = await page.evaluate(() => {
            let price = 0;
            let cleanTitle = document.querySelector('h1')?.innerText || document.title;
            cleanTitle = cleanTitle.split('|')[0].split('- Buy')[0].split('- Price')[0].trim();

            // Engine 1: JSON-LD Extraction
            const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
            for (const script of ldScripts) {
                try {
                    const parsed = JSON.parse(script.innerText);
                    const items = Array.isArray(parsed) ? parsed : [parsed];
                    for (const item of items) {
                        let target = null;
                        if (item['@type'] === 'Product') {
                            target = item;
                        } else if (item['@graph'] && Array.isArray(item['@graph'])) {
                            target = item['@graph'].find(g => g['@type'] === 'Product');
                        }

                        if (target && target.offers) {
                            let offers = Array.isArray(target.offers) ? target.offers : [target.offers];
                            for (let offer of offers) {
                                if (offer.price) {
                                    price = parseFloat(String(offer.price).replace(/[^\d.]/g, ''));
                                } else if (offer.lowPrice) {
                                    price = parseFloat(String(offer.lowPrice).replace(/[^\d.]/g, ''));
                                }
                                if (price > 0) break;
                            }
                            if (target.name) cleanTitle = target.name.split('|')[0].split('- Buy')[0].trim();
                        }
                    }
                    if (price > 0) break;
                } catch(e) {}
            }

            // Engine 2: Strict Class Fallback Chain
            if (price === 0) {
                const priceSelectors = [
                    '.a-price-whole', '._30jeq3', '.Nx9bqj', 
                    '._1V76Xq', '._25b18c', '[data-qa="product-price"]', 
                    '.price', '.product-price', '.final-price'
                ];
                for (const sel of priceSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.innerText) {
                        let extracted = parseFloat(el.innerText.replace(/[^\d.]/g, ''));
                        if (extracted > 0) { price = extracted; break; }
                    }
                }
            }

            const imgEl = document.querySelector('meta[property="og:image"]')?.content || document.querySelector('#landingImage, #imgTagWrapperId img, .a-dynamic-image, img[class*="v25dir"]')?.src;
            return { title: cleanTitle, price: price, imageUrl: imgEl || '' };
        });
        await browser.close();

        const safeTitle = data.title.replace(/'/g, "\\'").replace(/"/g, '\\"');
        const item = { id: String(Date.now()), title: data.title, price: data.price, link: targetUrl, imageUrl: data.imageUrl };
        
        if (item.price > 0) {
            await db.collection('wishlist').doc(item.id).set(item);
        }

        res.send(`
            <html style="background:#050505; color:#10b981; font-family:sans-serif; text-align:center; padding:2rem;">
                <h2 style="margin-top: 20px; color:#3b82f6;">🎯 Wallet V2.0</h2>
                <p style="color:#f3f4f6; margin: 15px 0; font-size: 14px; line-height: 1.4;">${item.title}</p>
                
                ${item.price > 0 ? `
                    <h1 style="color:#10b981; font-size: 40px; margin: 20px 0;">₹${item.price}</h1>
                    <p style="color:#10b981; font-weight:bold;">Saved to Cloud Database!</p>
                    <p style="color:#6b7280; font-size:12px; margin-top:20px;">Closing window...</p>
                    <script>setTimeout(() => window.close(), 2500);</script>
                ` : `
                    <div id="manualEntryBox" style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 16px; margin-top: 20px; border: 1px solid rgba(255,255,255,0.1);">
                        <p style="color:#ef4444; font-size:12px; font-weight:bold; text-transform:uppercase; letter-spacing:1px; margin-bottom:15px;">⚠️ Firewall Blocked Price</p>
                        <input type="number" id="manualPrice" placeholder="Enter Price (₹)" style="background: rgba(0,0,0,0.5); color: #10b981; font-size: 24px; font-weight: bold; text-align: center; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 15px; width: 100%; outline: none; margin-bottom: 15px;" autofocus>
                        <button onclick="saveManualData()" style="background: #3b82f6; color: white; border: none; padding: 15px; width: 100%; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer; transition: 0.2s;">Save to Tracker</button>
                    </div>

                    <script>
                        function saveManualData() {
                            const btn = document.querySelector('button');
                            const priceInput = document.getElementById('manualPrice').value;
                            
                            if (!priceInput || priceInput <= 0) return;
                            
                            btn.innerText = "Syncing to Cloud...";
                            btn.style.background = "#10b981";
                            
                            fetch('/api/add-wishlist', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
                                body: JSON.stringify({ 
                                    id: '${item.id}', 
                                    title: '${safeTitle}', 
                                    price: parseFloat(priceInput), 
                                    link: '${item.link}', 
                                    imageUrl: '${item.imageUrl}' 
                                })
                            }).then(() => {
                                document.getElementById('manualEntryBox').innerHTML = '<h1 style="color:#10b981; font-size: 30px; margin: 30px 0;">Saved! 🎯</h1><p style="color:#6b7280; font-size:12px;">Closing window...</p>';
                                setTimeout(() => window.close(), 1500);
                            });
                        }
                    </script>
                `}
            </html>
        `);
    } catch (error) {
        if (browser) await browser.close();
        res.send("<h2 style='color:#ef4444; text-align:center; font-family:sans-serif; margin-top:50px;'>Network error. Try adding manually.</h2>");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));