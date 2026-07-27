const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');

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

app.get('/api/ping', (req, res) => res.status(200).send('OK'));

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
        await db.collection('transactions').doc(id).update(req.body);
        res.status(200).json({ message: 'Updated successfully' });
    } catch (error) { res.status(500).json({ error: 'Failed to update transaction' }); }
});

app.post('/api/sync-transactions', async (req, res) => {
    try {
        const transactions = req.body;
        const batch = db.batch();
        transactions.forEach(tx => { batch.set(db.collection('transactions').doc(tx.id), tx); });
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
        items.forEach(item => { batch.set(db.collection('wishlist').doc(item.id), item); });
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
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `You are a sharp, highly intelligent personal financial assistant. 
        Analyze these transactions (with pre-calculated totals): ${JSON.stringify(transactions)}. 
        The user's monthly budget is ₹${monthlyBudget}. 
        Provide a quick, conversational financial summary, followed by ONE highly actionable piece of advice. 
        STRICT RULES: 1. Speak directly to the user in a cool, helpful tone. 2. DO NOT use any markdown formatting. 3. Keep it to 3-4 short sentences total. 4. Use normal line breaks to separate the summary from the advice.`;

        const result = await model.generateContent(prompt);
        res.status(200).json({ advice: result.response.text() });
    } catch (error) { res.status(500).json({ error: 'Failed to generate' }); }
});

// BULK SMS SYNC ROUTE
app.post('/api/bulk-sms', async (req, res) => {
    try {
        const { bulkText } = req.body;
        if (!bulkText) return res.status(400).json({ error: 'No text provided' });

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `Analyze this large block of text which contains multiple historical bank SMS messages:
        "${bulkText}"
        
        Extract EVERY valid transaction (income or expense) you can find. Ignore OTPs and non-financial spam.
        Rules for "category":
        - Expense ONLY: 'Food & Dining', 'Groceries', 'Transport', 'Utilities', 'Electricity charges', 'Rent', 'Education', 'Travel', 'Shopping', 'Entertainment', 'Health', 'Subscriptions', 'Other'.
        - Income ONLY: 'Salary', 'Freelance', 'Investments', 'Refund', 'Other'.
        
        Return ONLY a JSON array of objects. Format strictly like this:
        [
          {"amount": 500, "merchant": "Swiggy", "date": "YYYY-MM-DD", "type": "expense", "category": "Food & Dining", "rawText": "Rs 500 debited..."},
          {"amount": 10000, "merchant": "Salary Info", "date": "YYYY-MM-DD", "type": "income", "category": "Salary", "rawText": "Rs 10,000 credited..."}
        ]`;

        const result = await model.generateContent(prompt);
        const jsonMatch = result.response.text().match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("No JSON array returned");
        
        const parsedArray = JSON.parse(jsonMatch[0]);
        const batch = db.batch();

        parsedArray.forEach(parsedData => {
            if (parsedData.amount > 0) {
                const txId = String(Date.now() + Math.floor(Math.random() * 1000));
                const txData = { 
                    id: txId, type: parsedData.type || 'expense', amount: parsedData.amount || 0, merchant: parsedData.merchant || 'Unknown Vendor', account: 'UPI', category: parsedData.category || 'Other', note: (parsedData.merchant || 'Transaction') + " (Bulk SMS)", timestamp: Date.now(), isRecurring: false, rawMessage: parsedData.rawText || 'Bulk Upload', sender: 'Bulk Sync'
                };
                batch.set(db.collection('pending').doc(txId), txData);
            }
        });

        await batch.commit();
        res.status(201).json({ message: 'Successfully synced historical SMS messages.' });
    } catch (error) { 
        res.status(500).json({ error: 'Bulk processing exception occurred.' }); 
    }
});

app.post('/api/sms-webhook', async (req, res) => {
    try {
        const rawText = req.body.smsText || req.body.message || JSON.stringify(req.body);
        const sender = req.body.sender || 'Bank SMS';

        console.log("📲 INCOMING SMS RECEIVED:", { rawText, sender });

        if (!rawText || rawText === '{}') {
            return res.status(400).json({ error: 'No SMS text provided' });
        }

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `Analyze this bank SMS: "${rawText}". 
        Extract the amount, merchant, date, type (income/expense), and category.
        Rules for "category":
        - For expense, choose from ONLY these: 'Food & Dining', 'Groceries', 'Transport', 'Utilities', 'Electricity charges', 'Rent', 'Education', 'Travel', 'Shopping', 'Entertainment', 'Health', 'Subscriptions', 'Other'.
        - For income, choose from: 'Salary', 'Freelance', 'Investments', 'Refund', 'Other'.
        Return ONLY a valid JSON object matching this structure exactly: 
        {"amount": number, "merchant": string, "date": "YYYY-MM-DD", "type": "income" | "expense", "category": string}. 
        If you cannot process it, return {"error":"invalid"}`;

        const result = await model.generateContent(prompt);
        const jsonMatch = result.response.text().match(/\{[\s\S]*\}/);
        const cleanText = jsonMatch ? jsonMatch[0] : "{}";
        const parsedData = JSON.parse(cleanText);

        const txId = String(Date.now());
        let txData;

        if (parsedData.error || !parsedData.amount) {
            txData = { id: txId, type: 'expense', amount: 0, merchant: 'Parse Error', account: 'UPI', category: 'Other', note: 'AI failed to parse', timestamp: Date.now(), isRecurring: false, rawMessage: rawText, sender: sender };
        } else {
            txData = { id: txId, type: parsedData.type || 'expense', amount: parsedData.amount || 0, merchant: parsedData.merchant || 'Unknown Vendor', account: 'UPI', category: parsedData.category || 'Other', note: (parsedData.merchant || 'Transaction') + " (SMS)", timestamp: Date.now(), isRecurring: false, rawMessage: rawText, sender: sender };
        }
        
        await db.collection('pending').doc(txId).set(txData);
        res.status(201).json({ message: 'Saved to pending firestore queue', data: txData });
        
    } catch (error) { 
        try {
            const txId = String(Date.now());
            const failData = { id: txId, type: 'expense', amount: 0, merchant: 'System Error', account: 'UPI', category: 'Other', note: 'Webhook crashed', timestamp: Date.now(), isRecurring: false, rawMessage: req.body.smsText || 'Error', sender: 'System' };
            await db.collection('pending').doc(txId).set(failData);
            res.status(201).json({ message: 'Saved raw error to queue', data: failData });
        } catch (dbErr) {
            res.status(500).json({ error: 'Fatal webhook crash.' }); 
        }
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
            const finalTx = { id: approvedTxn.id, type: approvedTxn.type || 'expense', amount: approvedTxn.amount, account: approvedTxn.account || 'UPI', category: approvedTxn.category || 'Other', note: approvedTxn.note || approvedTxn.merchant, timestamp: approvedTxn.timestamp, isRecurring: false };
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
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const receiptImageBufferPart = { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } };
        const prompt = `Analyze this complex receipt/bill image closely. Even if it is blurry, itemized, or layout-dense, extract the overall Grand Total amount paid. Return ONLY a valid JSON object in this format: { "total": number }. If no numbers are decipherable, return { "total": 0 }. Do not write markdown wrapping.`;

        const result = await model.generateContent([prompt, receiptImageBufferPart]);
        let cleanText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
        res.status(200).json(JSON.parse(cleanText));
    } catch (error) { res.status(500).json({ error: 'AI Vision decoding exception occurred.' }); }
});

// =======================================================
//   PROXY & AI SCRAPER (No Puppeteer - Ultra Fast / No Render crashes)
// =======================================================
app.post('/api/scrape-price', async (req, res) => {
    const targetUrl = req.body.url;
    if (!targetUrl) return res.status(400).json({ error: 'No URL provided' });

    try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
        const fetchRes = await fetch(proxyUrl);
        const proxyData = await fetchRes.json();
        const html = proxyData.contents || '';

        let title = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)?.[1] || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
        let imageUrl = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)?.[1] || html.match(/<img[^>]*id="landingImage"[^>]*src="([^"]+)"/i)?.[1] || '';
        let priceMatch = html.match(/(?:₹|Rs\.?|INR)\s*([0-9,]{2,}(?:\.[0-9]{2})?)/i);
        let price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

        title = title.replace(/Product summary presents key product information/gi, '').split('|')[0].split('- Buy')[0].split('- Price')[0].split(': Amazon')[0].trim();

        if (title.length < 3 || title.includes("Amazon.in") || title.includes("Online Shopping")) {
            const urlPath = new URL(targetUrl).pathname.split('/').filter(p => p.length > 2)[0];
            if (urlPath) title = urlPath.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        }

        if (price === 0) {
            try {
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const prompt = `Act as a web scraper. Predict the product title and approximate price from this URL: "${targetUrl}". Return ONLY JSON: {"title":"[predicted name]","price": 0}`;
                const aiRes = await model.generateContent(prompt);
                const aiJsonMatch = aiRes.response.text().match(/\{[\s\S]*\}/);
                const aiJson = JSON.parse(aiJsonMatch ? aiJsonMatch[0] : "{}");
                if (aiJson.title && title.length < 3) title = aiJson.title;
                if (aiJson.price && price === 0) price = aiJson.price;
            } catch(e) {}
        }

        res.status(200).json({ title: title || 'Saved Product', price: price || 0, imageUrl: imageUrl });
    } catch (error) {
        res.status(500).json({ error: 'Scraping failed completely' });
    }
});

// MEDIA SCRAPER (IMDb/Amazon/Goodreads)
app.post('/api/scrape-media', async (req, res) => {
    const targetUrl = req.body.url;
    if (!targetUrl) return res.status(400).json({ error: 'No URL provided' });

    console.log("🎬 SCRAPING MEDIA URL:", targetUrl);

    try {
        const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`;
        const fetchRes = await fetch(proxyUrl);
        const proxyData = await fetchRes.json();
        const html = proxyData.contents || '';

        let title = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1] || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
        let imageUrl = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i)?.[1] || '';
        let description = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)?.[1] || html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1] || '';
        let jsonLdRawMatch = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi);

        let details = '';
        let mediaType = 'Movie';
        let rating = 'Unrated';
        let genre = 'Other';
        let price = 0;

        if (/book|goodreads|isbn|pages/i.test(targetUrl + title + description)) mediaType = 'Book';
        else if (/series|tv|season|episode/i.test(targetUrl + title + description)) mediaType = 'Series';
        if (/anime|myanimelist|crunchyroll/i.test(targetUrl + title + description)) mediaType = 'Anime';

        if (jsonLdRawMatch) {
            for (let block of jsonLdRawMatch) {
                try {
                    let inner = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
                    let parsed = JSON.parse(inner);
                    let items = Array.isArray(parsed) ? parsed : [parsed];
                    
                    for (let item of items) {
                        if (item['@graph']) items.push(...item['@graph']);
                        
                        if (['Movie', 'TVSeries', 'Book', 'Product'].includes(item['@type']) || item.aggregateRating) {
                            if (item.name && !title) title = item.name;
                            if (item.image && !imageUrl) imageUrl = typeof item.image === 'string' ? item.image : item.image?.url;
                            
                            if (item.aggregateRating?.ratingValue) {
                                const s = parseFloat(item.aggregateRating.ratingValue);
                                rating = s >= 8.5 ? '5' : s >= 7.5 ? '4' : s >= 6.5 ? '3' : s >= 5.0 ? '2' : '1';
                                if (!details.includes('⭐')) details += `⭐ ${s}/10`;
                            }
                            
                            if (item.duration) {
                                const durMatch = String(item.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
                                if (durMatch) {
                                    const h = durMatch[1] ? `${durMatch[1]}h` : '';
                                    const m = durMatch[2] ? `${durMatch[2]}m` : '';
                                    const dStr = `⏱️ ${h} ${m}`.trim();
                                    if (!details.includes(dStr)) details += (details ? ` • ${dStr}` : dStr);
                                }
                            }

                            if (item.genre) {
                                const gArr = Array.isArray(item.genre) ? item.genre : [item.genre];
                                genre = gArr[0].split(',')[0].trim();
                            }
                        }
                    }
                } catch (e) {}
            }
        }

        if (!details.includes('⏱️')) {
            let durationMatch = html.match(/(\d{1,2}h\s*\d{1,2}m|\d{2,3} mins?)/i);
            if (durationMatch) details += (details ? ` • ⏱️ ${durationMatch[1]}` : `⏱️ ${durationMatch[1]}`);
        }

        if (mediaType === 'Book' && !details.includes('pages')) {
            let pagesMatch = html.match(/(\d{1,4})\s*pages/i);
            if (pagesMatch) details += (details ? ` • 📖 ${pagesMatch[1]} pages` : `📖 ${pagesMatch[1]} pages`);
        }

        if (title) {
            title = title.replace(/\(TV Series.*?\)/gi, '').replace(/- IMDb/gi, '').split('|')[0].trim();
            console.log("✅ SCRAPE SUCCESS:", title);
            return res.status(200).json({ title, imageUrl, mediaType, details, genre, mediaRating: rating, price });
        } else {
            throw new Error("Proxy fetch successful but title was empty");
        }
    } catch(e) {
        console.log("⚠️ Fast fetch failed, falling back to Gemini AI scraper...");
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const prompt = `Act as a web scraper. I am giving you a URL: "${targetUrl}". Guess the movie or book name from the URL string itself. Return ONLY a JSON object predicting the metadata: {"title":"[guessed title]","imageUrl":"","mediaType":"Movie","genre":"Other","details":"","mediaRating":"5"}`;
            const aiRes = await model.generateContent(prompt);
            const aiJsonMatch = aiRes.response.text().match(/\{[\s\S]*\}/);
            const aiJson = JSON.parse(aiJsonMatch ? aiJsonMatch[0] : "{}");
            
            if (aiJson.title) return res.status(200).json(aiJson);
            throw new Error("AI Fallback failed");
        } catch(fallbackErr) {
            res.status(500).json({ error: 'Media scraping completely failed' });
        }
    }
});

// FAST FIREWALL BYPASS ROUTE
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