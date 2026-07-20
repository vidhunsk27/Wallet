const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const puppeteer = require('puppeteer');

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
//      UPTIME MONITOR (KEEPS SERVER AWAKE)
// ==========================================

app.get('/api/ping', (req, res) => {
    res.status(200).send('OK');
});

// ==========================================
//          CORE DATABASE ROUTES
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

app.put('/api/edit-transaction/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updatedData = req.body;
        await db.collection('transactions').doc(id).update(updatedData);
        res.status(200).json({ message: 'Updated successfully' });
    } catch (error) { res.status(500).json({ error: 'Failed to update transaction' }); }
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
//            AI & TOOL ROUTES
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
        2. DO NOT use any markdown formatting.
        3. Keep it to 3-4 short sentences total.
        4. Use normal line breaks to separate the summary from the advice.`;

        const result = await model.generateContent(prompt);
        res.status(200).json({ advice: result.response.text() });
    } catch (error) { res.status(500).json({ error: 'Failed to generate' }); }
});

app.post('/api/sms-webhook', async (req, res) => {
    try {
        const rawText = req.body.smsText || req.body.message;
        const sender = req.body.sender || 'Bank SMS';

        if (!rawText) return res.status(400).json({ error: 'No SMS text provided' });

        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        // SMART AUTO-CATEGORIZATION PROMPT
        const prompt = `Analyze this bank SMS: "${rawText}". 
        Extract the amount, merchant, date, type (income/expense), and category.
        
        Rules for "category":
        - For expense, choose from ONLY these: 'Food & Dining', 'Groceries', 'Transport', 'Utilities', 'Electricity Bill', 'Rent', 'Education', 'Travel', 'Shopping', 'Entertainment', 'Health', 'Subscriptions', 'Other'.
        - Example mapping: Swiggy/Zomato -> 'Food & Dining'. Uber/Ola/redBus/IRCTC -> 'Transport'. Amazon/Flipkart -> 'Shopping'. Electricity/TNEB -> 'Electricity Bill'. School/College -> 'Education'.
        - For income, choose from: 'Salary', 'Freelance', 'Investments', 'Refund', 'Other'.
        
        Return ONLY a valid JSON object matching this structure exactly: 
        {"amount": number, "merchant": string, "date": "YYYY-MM-DD", "type": "income" | "expense", "category": string}. 
        If you cannot process it, return {"error":"invalid"}`;

        const result = await model.generateContent(prompt);
        let cleanText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
        const parsedData = JSON.parse(cleanText);

        if (parsedData.error) return res.status(400).json({ message: 'Invalid SMS format' });

        const txId = String(Date.now());
        const txData = { 
            id: txId, 
            type: parsedData.type || 'expense', 
            amount: parsedData.amount || 0, 
            merchant: parsedData.merchant || 'Unknown Vendor', 
            account: 'UPI', 
            category: parsedData.category || 'Other', 
            note: (parsedData.merchant || 'Transaction') + " (SMS)", 
            timestamp: Date.now(), 
            isRecurring: false,
            rawMessage: rawText,
            sender: sender
        };
        
        await db.collection('pending').doc(txId).set(txData);
        res.status(201).json({ message: 'Saved to pending firestore queue', data: txData });
    } catch (error) { 
        console.error("SMS Parsing Error: ", error);
        res.status(500).json({ error: 'Webhook processing exception occurred.' }); 
    }
});

app.get('/api/pending', async (req, res) => {
    try {
        const snapshot = await db.collection('pending').get();
        res.status(200).json(snapshot.docs.map(doc => doc.data()));
    } catch (error) { res.status(500).json({ error: 'Failed to pull queue logs' }); }
});

app.post('/api/approve', async (req, res) => {
    try {
        const { id } = req.body;
        const docRef = db.collection('pending').doc(id);
        const doc = await docRef.get();
        
        if (doc.exists) {
            const approvedTxn = doc.data();
            const finalTx = {
                id: approvedTxn.id,
                type: approvedTxn.type || 'expense',
                amount: approvedTxn.amount,
                account: approvedTxn.account || 'UPI',
                category: approvedTxn.category || 'Other',
                note: approvedTxn.note || approvedTxn.merchant,
                timestamp: approvedTxn.timestamp,
                isRecurring: false
            };
            
            await db.collection('transactions').doc(finalTx.id).set(finalTx);
            await docRef.delete();
            res.json({ success: true, message: "Approved successfully", data: finalTx });
        } else {
            res.status(404).json({ error: "Transaction index tracking vector not found" });
        }
    } catch (error) { res.status(500).json({ error: 'Approval processing failure' }); }
});

app.post('/api/reject', async (req, res) => {
    try {
        const { id } = req.body;
        await db.collection('pending').doc(id).delete();
        res.json({ success: true, message: "Rejected and safely expunged from dataset" });
    } catch (error) { res.status(500).json({ error: 'Rejection routing failed' }); }
});

app.post('/api/receipt-ocr', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image element payload detected.' });
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const receiptImageBufferPart = { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } };
        const prompt = `Analyze this complex receipt/bill image closely. Even if it is blurry, itemized, or layout-dense, extract the overall Grand Total amount paid. Return ONLY a valid JSON object in this format: { "total": number }. If no numbers are decipherable, return { "total": 0 }. Do not write markdown wrapping.`;

        const result = await model.generateContent([prompt, receiptImageBufferPart]);
        let cleanText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
        res.status(200).json(JSON.parse(cleanText));
    } catch (error) { 
        console.error("Vision Processing Module Crash Exception: ", error);
        res.status(500).json({ error: 'AI Vision decoding exception occurred.' }); 
    }
});

// =======================================================
//   HIGH-SPEED BLAZING SCRAPER (BLOCKS IMAGES/FONTS)
// =======================================================
app.post('/api/scrape-price', async (req, res) => {
    const targetUrl = req.body.url;
    if (!targetUrl) return res.status(400).json({ error: 'No URL provided' });

    let browser;
    try {
        browser = await puppeteer.launch({ 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'] 
        });
        const page = await browser.newPage();
        
        // INTERCEPTOR: Stop images/fonts/css from loading so it fetches 10x faster!
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
            else req.continue();
        });

        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 1000)); // Lowered wait time because page is lighter

        const scrapedData = await page.evaluate(() => {
            let title = '';
            let price = 0;

            const titleEl = document.querySelector('#productTitle, span.B_NuCI, .VU-VGd, ._2xm_p6, h1._6ERyO0, .product-title, meta[property="og:title"]');
            if (titleEl) title = titleEl.content || titleEl.innerText || '';
            if (!title || title.includes('Online Shopping for Men')) title = document.querySelector('h1')?.innerText || document.title || '';

            title = title.replace(/Product summary presents key product information/gi, '').replace(/Keyboard shortcut\s*shift\s*\+\s*alt\s*\+\s*[A-Z]/gi, '').split('|')[0].split('- Buy')[0].split('- Price')[0].split(': Amazon')[0].trim();

            let pMeta = document.querySelector('meta[property="product:price:amount"]')?.content || document.querySelector('meta[property="og:price:amount"]')?.content;
            if (pMeta) {
                let parsedMeta = parseFloat(pMeta.replace(/[^\d.]/g, ''));
                if (parsedMeta > 10) price = parsedMeta;
            }

            if (price === 0 || isNaN(price) || price < 10) {
                const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
                for (const script of ldScripts) {
                    try {
                        const parsed = JSON.parse(script.innerText);
                        const items = Array.isArray(parsed) ? parsed : [parsed];
                        for (const item of items) {
                            let target = null;
                            if (item['@type'] === 'Product') target = item;
                            else if (item['@graph'] && Array.isArray(item['@graph'])) target = item['@graph'].find(g => g['@type'] === 'Product');

                            if (target && target.offers) {
                                let offers = Array.isArray(target.offers) ? target.offers : [target.offers];
                                for (let offer of offers) {
                                    if (offer.price) price = parseFloat(String(offer.price).replace(/[^\d.]/g, ''));
                                    else if (offer.lowPrice) price = parseFloat(String(offer.lowPrice).replace(/[^\d.]/g, ''));
                                    if (price > 10) break;
                                }
                                if (target.name && (!title || title.length < 5)) title = target.name.split('|')[0].split('- Buy')[0].trim();
                            }
                        }
                        if (price > 10) break;
                    } catch(e) {}
                }
            }

            if (price === 0 || isNaN(price) || price < 10) {
                const priceSelectors = ['div[class*="Nx9bqj"]', '.a-price-whole', '._30jeq3', '._1V76Xq', '._25b18c', '[data-qa="product-price"]', '.price', '.product-price', '.final-price', '.pdp-price', '.discounted-price', '.fbold'];
                for (const sel of priceSelectors) {
                    const el = document.querySelector(sel);
                    if (el && el.innerText) {
                        let extracted = parseFloat(el.innerText.replace(/[^\d.]/g, ''));
                        if (extracted > 10) { price = extracted; break; }
                    }
                }
            }

            if (price === 0 || isNaN(price) || price < 10) {
                let match = document.body.innerText.match(/(?:₹|Rs\.?|INR)\s*([0-9,]{2,}(?:\.[0-9]{2})?)/i);
                if (match) price = parseFloat(match[1].replace(/,/g, ''));
            }

            const imgEl = document.querySelector('meta[property="og:image"]')?.content || document.querySelector('#landingImage, #imgTagWrapperId img, .a-dynamic-image, img._396cs4, ._2r_T1I, img[class*="v25dir"]')?.src;
            return { title, price: price || 0, imageUrl: imgEl || '' };
        });

        await browser.close();

        if (!scrapedData.title || scrapedData.title.length < 3 || scrapedData.title.includes('Online Shopping')) {
            try {
                const pathParts = new URL(targetUrl).pathname.split('/').filter(p => p.length > 2);
                if (pathParts.length > 0) scrapedData.title = pathParts[0].replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            } catch(e) {}
        }
        res.status(200).json(scrapedData);
    } catch (error) {
        if (browser) await browser.close();
        try {
            const response = await fetch(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
            const html = await response.text();
            let titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
            let imgMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"[^>]*>/i);
            let priceMatch = html.match(/(?:₹|Rs\.?|INR)\s*([0-9,]{2,})/i);
            let cleanTitle = titleMatch ? titleMatch[1].split('|')[0].split('- Buy')[0].trim() : 'Saved Item';
            if (cleanTitle.includes('Online Shopping')) cleanTitle = new URL(targetUrl).pathname.split('/')[1]?.replace(/[-_]/g, ' ') || 'Saved Item';
            res.status(200).json({ title: cleanTitle, price: priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0, imageUrl: imgMatch ? imgMatch[1] : '' });
        } catch (fallbackErr) {
            res.status(500).json({ error: 'Scraping failed completely' });
        }
    }
});

// FAST FIREWALL BYPASS ROUTE (RICH FULL METADATA SYNC)
app.get('/api/bookmark-auto', async (req, res) => {
    const { title, price, link, img, cat } = req.query;
    if (!link || !price) return res.send("Error: Missing parameters.");
    let hostname = 'ONLINE';
    try { hostname = new URL(link).hostname.replace('www.', '').split('.')[0].toUpperCase(); } catch(e) {}

    const safeTitle = title ? decodeURIComponent(title) : 'Saved Item';
    const safeImg = img ? decodeURIComponent(img) : '';
    const safeCat = cat ? decodeURIComponent(cat) : hostname;

    const item = { 
        id: String(Date.now()), title: safeTitle, price: parseFloat(price) || 0, link: decodeURIComponent(link), imageUrl: safeImg, category: safeCat, wishCategory: 'Other', timestamp: Date.now()
    };
    
    try {
        await db.collection('wishlist').doc(item.id).set(item);
        res.send(`
            <html style="background:#050505; color:#10b981; font-family:sans-serif; padding:2rem; display:flex; justify-content:center; align-items:center; height:100vh; overflow:hidden;">
                <div style="background:rgba(255,255,255,0.05); padding:30px; border-radius:24px; text-align:center; max-width:400px; border:1px solid rgba(255,255,255,0.1); box-shadow:0 10px 40px rgba(0,0,0,0.5);">
                    <h2 style="margin-top:0; color:#3b82f6; font-size:24px;">🎯 Wishlist Added</h2>
                    ${safeImg ? `<img src="${safeImg}" style="width:100%; height:180px; object-fit:cover; border-radius:12px; margin:15px 0;">` : ''}
                    <div style="margin: 10px 0;"><span style="background:rgba(59,130,246,0.15); color:#60a5fa; padding:4px 10px; border-radius:8px; font-size:11px; font-weight:bold; text-transform:uppercase;">${safeCat}</span></div>
                    <p style="color:#f3f4f6; margin: 15px 0; font-size: 14px; line-height: 1.4; font-weight:bold;">${safeTitle}</p>
                    <h1 style="color:#10b981; font-size: 40px; margin: 10px 0;">₹${item.price.toLocaleString()}</h1>
                    <p style="color:#10b981; font-weight:bold;">Saved to Database Successfully!</p>
                    <p style="color:#6b7280; font-size:12px; margin-top:20px;">Closing window...</p>
                </div>
                <script>setTimeout(() => window.close(), 2500);</script>
            </html>
        `);
    } catch(err) {
        res.send("<h2 style='color:#ef4444; text-align:center;'>Database sync failed.</h2>");
    }
});

// MANUAL FALLBACK BOOKMARKLET ROUTE
app.get('/api/bookmark', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.send("No URL provided.");
    
    res.send(`
        <html style="background:#050505; color:#10b981; font-family:sans-serif; text-align:center; padding:2rem;">
            <h2 style="margin-top: 20px; color:#3b82f6;">🎯 Wallet V2.0</h2>
            <div id="manualEntryBox" style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 16px; margin-top: 20px; border: 1px solid rgba(255,255,255,0.1);">
                <p style="color:#ef4444; font-size:12px; font-weight:bold; text-transform:uppercase; letter-spacing:1px; margin-bottom:15px;">⚠️ Enter Details Manually</p>
                <input type="text" id="manualName" placeholder="Product Name" style="background: rgba(0,0,0,0.5); color: #fff; font-size: 16px; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 15px; width: 100%; outline: none; margin-bottom: 10px;">
                <select id="manualCategory" style="background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 12px; width: 100%; outline: none; margin-bottom: 12px;">
                    <option value="Gadgets">💻 Gadgets</option><option value="Apparel">👕 Apparel</option><option value="Lifestyle">✨ Lifestyle</option><option value="Other">📦 Other</option>
                </select>
                <input type="number" id="manualPrice" placeholder="Enter Price (₹)" style="background: rgba(0,0,0,0.5); color: #10b981; font-size: 24px; font-weight: bold; text-align: center; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 15px; width: 100%; outline: none; margin-bottom: 15px;" autofocus>
                <button onclick="saveManualData()" style="background: #3b82f6; color: white; border: none; padding: 15px; width: 100%; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer; transition: 0.2s;">Save to Tracker</button>
            </div>
            <script>
                function saveManualData() {
                    const btn = document.querySelector('button');
                    const priceInput = document.getElementById('manualPrice').value;
                    const nameInput = document.getElementById('manualName').value || 'Saved Item';
                    const catInput = document.getElementById('manualCategory').value;
                    if (!priceInput || priceInput <= 0) return;
                    btn.innerText = "Syncing to Cloud..."; btn.style.background = "#10b981";
                    fetch('https://wallet-y7yv.onrender.com/api/add-wishlist', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: String(Date.now()), title: nameInput, price: parseFloat(priceInput), link: '${targetUrl}', imageUrl: '', category: 'MANUAL', wishCategory: catInput, timestamp: Date.now() })
                    }).then(() => {
                        document.getElementById('manualEntryBox').innerHTML = '<h1 style="color:#10b981; font-size: 30px; margin: 30px 0;">Saved! 🎯</h1>';
                        setTimeout(() => window.close(), 1500);
                    });
                }
            </script>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));