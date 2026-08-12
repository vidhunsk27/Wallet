const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (process.env.NODE_ENV !== 'production') require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
const upload = multer({ storage: multer.memoryStorage() });

const apiKey = process.env.GEMINI_API_KEY || "YOUR_API_KEY_HERE";
const genAI = new GoogleGenerativeAI(apiKey);

let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    else serviceAccount = require('./serviceAccountKey.json');
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

async function fetchPageHtml(targetUrl) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };
    const response = await fetch(targetUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(10000) });
    return await response.text();
}

app.get('/api/ping', (req, res) => res.status(200).send('OK'));

app.get('/api/get-transactions', async (req, res) => {
    try {
        const snapshot = await db.collection('transactions').get();
        res.status(200).json(snapshot.docs.map(doc => doc.data()));
    } catch (error) { res.status(500).json({ error: 'Failed to fetch' }); }
});

app.post('/api/add-transaction', async (req, res) => {
    try {
        const transaction = req.body;
        if (!transaction || !transaction.id) return res.status(400).json({ error: 'Transaction ID is required' });
        await db.collection('transactions').doc(String(transaction.id)).set(transaction);
        res.status(201).json({ message: 'Added successfully', data: transaction });
    } catch (error) { res.status(500).json({ error: 'Failed to add' }); }
});

app.delete('/api/delete-transaction/:id', async (req, res) => {
    try {
        await db.collection('transactions').doc(String(req.params.id)).delete();
        res.status(200).json({ message: 'Deleted' });
    } catch (error) { res.status(500).json({ error: 'Failed to delete' }); }
});

app.put('/api/edit-transaction/:id', async (req, res) => {
    try {
        await db.collection('transactions').doc(String(req.params.id)).update(req.body);
        res.status(200).json({ message: 'Updated successfully' });
    } catch (error) { res.status(500).json({ error: 'Failed to update transaction' }); }
});

app.post('/api/sync-transactions', async (req, res) => {
    try {
        const transactions = req.body;
        if (!Array.isArray(transactions)) return res.status(400).json({ error: 'Expected an array of transactions' });
        const validTransactions = transactions.filter(tx => tx && tx.id !== undefined && tx.id !== null);
        let syncedCount = 0;
        for (let start = 0; start < validTransactions.length; start += 450) {
            const chunk = validTransactions.slice(start, start + 450);
            const batch = db.batch();
            chunk.forEach(tx => batch.set(db.collection('transactions').doc(String(tx.id)), tx));
            await batch.commit();
            syncedCount += chunk.length;
        }
        res.status(200).json({ message: 'Sync complete', count: syncedCount });
    } catch (error) { res.status(500).json({ error: 'Failed to sync' }); }
});

app.post('/api/backup-transactions', async (req, res) => {
    try {
        const transactions = Array.isArray(req.body.transactions) ? req.body.transactions : [];
        if (transactions.length === 0) return res.status(400).json({ error: 'Backup refused because transaction list is empty' });
        const cleanedTransactions = transactions.filter(tx => tx && tx.id !== undefined && tx.id !== null);
        if (cleanedTransactions.length === 0) return res.status(400).json({ error: 'Backup refused because no valid transactions were supplied' });
        await db.collection('settings').doc('transactionBackupLatest').set({ transactions: cleanedTransactions, count: cleanedTransactions.length, createdAt: Date.now(), source: req.body.source || 'Wally MK 2', version: 1 });
        res.status(200).json({ message: 'Protected transaction backup saved', count: cleanedTransactions.length, createdAt: Date.now() });
    } catch (error) { res.status(500).json({ error: 'Failed to backup transactions' }); }
});

app.get('/api/get-transaction-backup', async (req, res) => {
    try {
        const backupDoc = await db.collection('settings').doc('transactionBackupLatest').get();
        if (!backupDoc.exists) return res.status(404).json({ error: 'No transaction backup found' });
        res.status(200).json(backupDoc.data());
    } catch (error) { res.status(500).json({ error: 'Failed to retrieve transaction backup' }); }
});

app.get('/api/transaction-status', async (req, res) => {
    try {
        const transactionSnapshot = await db.collection('transactions').get();
        const backupDoc = await db.collection('settings').doc('transactionBackupLatest').get();
        let backupCount = 0; let backupCreatedAt = null;
        if (backupDoc.exists) {
            const backup = backupDoc.data();
            if (Array.isArray(backup.transactions)) backupCount = backup.transactions.length;
            backupCreatedAt = backup.createdAt || null;
        }
        res.status(200).json({ transactionCount: transactionSnapshot.size, backupCount: backupCount, backupCreatedAt: backupCreatedAt, firestoreConnected: true });
    } catch (error) { res.status(500).json({ error: 'Failed to read transaction status', firestoreConnected: false }); }
});

app.get('/api/get-wishlist', async (req, res) => {
    try {
        const snapshot = await db.collection('wishlist').get();
        res.status(200).json(snapshot.docs.map(doc => doc.data()));
    } catch (error) { res.status(500).json({ error: 'Failed to fetch' }); }
});

app.post('/api/add-wishlist', async (req, res) => {
    try {
        await db.collection('wishlist').doc(String(req.body.id)).set(req.body);
        res.status(201).json({ message: 'Added successfully' });
    } catch (error) { res.status(500).json({ error: 'Failed to add' }); }
});

app.delete('/api/delete-wishlist/:id', async (req, res) => {
    try {
        await db.collection('wishlist').doc(String(req.params.id)).delete();
        res.status(200).json({ message: 'Deleted' });
    } catch (error) { res.status(500).json({ error: 'Failed to delete' }); }
});

app.post('/api/sync-wishlist', async (req, res) => {
    try {
        const items = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected an array' });
        for (let start = 0; start < items.length; start += 450) {
            const chunk = items.slice(start, start + 450);
            const batch = db.batch();
            chunk.forEach(item => { if (!item || !item.id) return; batch.set(db.collection('wishlist').doc(String(item.id)), item); });
            await batch.commit();
        }
        res.status(200).json({ message: 'Wishlist sync complete' });
    } catch (error) { res.status(500).json({ error: 'Failed to sync wishlist' }); }
});

app.get('/api/get-workspace', async (req, res) => {
    try {
        const doc = await db.collection('settings').doc('workspaceData').get();
        if (doc.exists) res.status(200).json(doc.data());
        else res.status(200).json({ notes: '', whiteboard: '' });
    } catch (error) { res.status(500).json({ error: 'Failed to fetch workspace' }); }
});

app.post('/api/save-workspace', async (req, res) => {
    try {
        await db.collection('settings').doc('workspaceData').set(req.body);
        res.status(200).json({ message: 'Workspace synced securely to cloud' });
    } catch (error) { res.status(500).json({ error: 'Failed to sync workspace' }); }
});

app.post('/api/jarvis-advice', async (req, res) => {
    try {
        const { transactions, monthlyBudget } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `You are C.A.S.P.E.R. (Calculated Asset Security and Personal Expense Recorder), a sharp, highly intelligent personal financial assistant for Vidhun. Analyze these transactions: ${JSON.stringify(transactions)}. The user's monthly budget is ₹${monthlyBudget}. Provide a quick, conversational financial summary, followed by ONE highly actionable piece of advice. STRICT RULES: 1. Speak directly to Vidhun. 2. Use a cool, precise tone. 3. DO NOT use markdown formatting. 4. Keep it to 3-4 short sentences total. 5. Use normal line breaks to separate the summary from the advice.`;
        const result = await model.generateContent(prompt);
        res.status(200).json({ advice: result.response.text() });
    } catch (error) { res.status(500).json({ error: 'Failed to generate' }); }
});

app.post('/api/jarvis-predict', async (req, res) => {
    try {
        const { currentMonthData, previousMonthData, currentBudget } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
        const prompt = `You are C.A.S.P.E.R., an elite predictive financial AI for Vidhun. Goal: correlate previous month's spending patterns with current month's trajectory, predict EOM expense, and tell him where to cut back. DATA INPUTS: Prev Month: ${JSON.stringify(previousMonthData)}, Current Month: ${JSON.stringify(currentMonthData)}, Budget: ₹${currentBudget}. YOUR TASK: Write a hyper-focused HTML forecast. Do NOT wrap in \`\`\`html. Use Tailwind classes: Headings: <h2 class="text-sm font-black text-purple-400 mb-2 mt-4 uppercase tracking-widest border-b border-white/10 pb-1">, Text: <p class="mb-3 text-sm text-gray-300">, Highlights: <span class="text-rose-400 font-bold">, Safe: <span class="text-emerald-400 font-bold">, Lists: <ul class="list-disc pl-5 mb-3 text-gray-300 space-y-2 text-sm">. STRUCTURE: 1. Correlation Analysis 2. EOM Prediction 3. The Cut List`;
        const result = await model.generateContent(prompt);
        res.status(200).json({ report: result.response.text().replace(/```html/gi, '').replace(/```/g, '').trim() });
    } catch (error) { res.status(500).json({ error: 'Failed to generate prediction' }); }
});

app.post('/api/jarvis-report', async (req, res) => {
    try {
        const { compiledMonths, monthlyBudget, selectedMonth } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `You are C.A.S.P.E.R., Vidhun's personal financial intelligence system. Analyze the supplied multi-month transaction data: ${JSON.stringify(compiledMonths)}. Selected filter month: ${selectedMonth}. Budget: ₹${monthlyBudget}. Create a structured HTML financial report (do NOT wrap in \`\`\`html). Use Tailwind classes: Headers: <h2 class="text-lg font-black text-blue-400 mb-2 mt-4 uppercase tracking-widest">, Text: <p class="mb-3 text-sm text-gray-300">, Lists: <ul class="list-disc pl-5 mb-3 text-gray-300 space-y-1">, Highlights: <strong class="text-white font-bold">. Structure: 1. Multi-Month Overview 2. Key Spend Drivers 3. Payment Method Analysis 4. 3 Strategic Recommendations.`;
        const result = await model.generateContent(prompt);
        res.status(200).json({ report: result.response.text().replace(/```html/gi, '').replace(/```/g, '').trim() });
    } catch (error) { res.status(500).json({ error: 'Failed to generate report' }); }
});

app.post('/api/bulk-sms', async (req, res) => {
    try {
        const { bulkText } = req.body;
        if (!bulkText) return res.status(400).json({ error: 'No text provided' });
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `Analyze this large block of text which contains multiple historical bank SMS messages: "${bulkText}". Extract EVERY valid transaction. Ignore OTPs. CRITICAL RULE: Extract the exact transaction AMOUNT debited or credited. NEVER extract 'Available Balance' or 'Avl Bal' as amount. Expense Categories: 'Food & Dining', 'Groceries', 'Transport', 'Utilities', 'Electricity charges', 'Mobile Recharge', 'Rent', 'Education', 'Travel', 'Shopping', 'Entertainment', 'Health', 'Subscriptions', 'Investments', 'Other'. Income Categories: 'Salary', 'Freelance', 'Refund', 'Other'. Return ONLY a JSON array of objects: [{"amount": 500, "merchant": "Swiggy", "date": "YYYY-MM-DD", "type": "expense", "category": "Food & Dining", "rawText": "Rs 500 debited..."}]`;
        const result = await model.generateContent(prompt);
        const jsonMatch = result.response.text().match(/\[[\s\S]*\]/);
        if (!jsonMatch) throw new Error("No JSON array returned");
        const parsedArray = JSON.parse(jsonMatch[0]);
        const batch = db.batch();
        const results = [];
        parsedArray.forEach(parsedData => {
            if (parsedData.amount === 0) {
                const fallbackAmountMatch = (parsedData.rawText || '').match(/(?:Rs\.?|INR|₹)\s*([0-9,]{1,}(?:\.[0-9]{1,2})?)/i);
                if (fallbackAmountMatch) parsedData.amount = parseFloat(fallbackAmountMatch[1].replace(/,/g, ''));
            }
            if (parsedData.amount > 0) {
                const txId = String(Date.now() + Math.floor(Math.random() * 1000));
                const txData = { id: txId, type: parsedData.type || 'expense', amount: parsedData.amount || 0, merchant: parsedData.merchant || 'Unknown Vendor', account: 'UPI', category: parsedData.category || 'Other', note: (parsedData.merchant || 'Transaction') + " (Bulk SMS)", timestamp: parsedData.date ? Date.parse(parsedData.date) || Date.now() : Date.now(), isRecurring: false, rawMessage: parsedData.rawText || 'Bulk Upload', sender: 'Bulk Sync' };
                batch.set(db.collection('pending').doc(txId), txData);
                results.push(txData);
            }
        });
        await batch.commit();
        res.status(201).json({ message: 'Successfully synced historical SMS messages.', count: results.length });
    } catch (error) { res.status(500).json({ error: 'Bulk processing exception occurred.' }); }
});

app.post('/api/sms-webhook', async (req, res) => {
    try {
        const rawText = req.body.smsText || req.body.message || req.body.sms || JSON.stringify(req.body);
        const sender = req.body.sender || 'Bank SMS';
        if (!rawText || rawText === '{}') return res.status(400).json({ error: 'No SMS text provided' });
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `Analyze this Indian bank SMS: "${rawText}". Extract transaction details. CRITICAL PARSING RULES: 1. EXTRACT THE EXACT DEBITED/CREDITED AMOUNT. 2. NEVER extract the account available balance ("Avl Bal", "Available Balance", "Bal") as the transaction amount. 3. If this is a personal non-banking message or just an OTP, return {"error":"invalid"}. 4. Return ONLY a valid JSON object matching this structure exactly: {"amount": number, "merchant": string, "date": "YYYY-MM-DD", "type": "income" | "expense", "category": string}.`;
        const result = await model.generateContent(prompt);
        const jsonMatch = result.response.text().match(/\{[\s\S]*\}/);
        const cleanText = jsonMatch ? jsonMatch[0] : "{}";
        let parsedData = JSON.parse(cleanText);
        const txId = String(Date.now());
        let txData;
        if (!parsedData.error && (!parsedData.amount || parsedData.amount === 0)) {
            const fallbackAmountMatch = rawText.match(/(?:Rs\.?|INR|₹)\s*([0-9,]{1,}(?:\.[0-9]{1,2})?)/i);
            if (fallbackAmountMatch) {
                if (!rawText.substring(Math.max(0, fallbackAmountMatch.index - 10), fallbackAmountMatch.index).match(/avl|bal|available/i)) {
                    parsedData.amount = parseFloat(fallbackAmountMatch[1].replace(/,/g, ''));
                }
            }
        }
        if (parsedData.error || !parsedData.amount) {
            txData = { id: txId, type: 'expense', amount: 0, merchant: 'Parse Error', account: 'UPI', category: 'Other', note: 'AI failed to parse', timestamp: Date.now(), isRecurring: false, rawMessage: rawText, sender: sender };
        } else {
            txData = { id: txId, type: parsedData.type || 'expense', amount: parsedData.amount || 0, merchant: parsedData.merchant || 'Unknown Vendor', account: 'UPI', category: parsedData.category || 'Other', note: (parsedData.merchant || 'Transaction') + " (SMS)", timestamp: parsedData.date ? Date.parse(parsedData.date) || Date.now() : Date.now(), isRecurring: false, rawMessage: rawText, sender: sender };
        }
        await db.collection('pending').doc(txId).set(txData);
        res.status(201).json({ message: 'Saved to pending firestore queue', data: txData });
    } catch (error) { 
        try {
            const txId = String(Date.now());
            const failData = { id: txId, type: 'expense', amount: 0, merchant: 'System Error', account: 'UPI', category: 'Other', note: 'Webhook crashed', timestamp: Date.now(), isRecurring: false, rawMessage: req.body.smsText || 'Error', sender: 'System' };
            await db.collection('pending').doc(txId).set(failData);
            res.status(201).json({ message: 'Saved raw error to queue', data: failData });
        } catch (dbErr) { res.status(500).json({ error: 'Fatal webhook crash.' }); }
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
        const id = String(req.body.id);
        if (!id) return res.status(400).json({ error: 'Transaction ID required' });
        const docRef = db.collection('pending').doc(id);
        const doc = await docRef.get();
        if (doc.exists) {
            const approvedTxn = doc.data();
            const finalTx = { id: approvedTxn.id, type: approvedTxn.type || 'expense', amount: approvedTxn.amount, account: approvedTxn.account || 'UPI', category: approvedTxn.category || 'Other', note: approvedTxn.note || approvedTxn.merchant, timestamp: approvedTxn.timestamp, isRecurring: false };
            await db.collection('transactions').doc(id).set(finalTx);
            await docRef.delete();
            res.json({ success: true, message: "Approved successfully", data: finalTx });
        } else {
            res.status(404).json({ error: "Transaction not found" });
        }
    } catch (error) { res.status(500).json({ error: 'Approval processing failure' }); }
});

app.post('/api/reject', async (req, res) => {
    try {
        const id = String(req.body.id);
        if (!id) return res.status(400).json({ error: 'Transaction ID required' });
        await db.collection('pending').doc(id).delete();
        res.json({ success: true, message: "Rejected and safely expunged" });
    } catch (error) { res.status(500).json({ error: 'Rejection routing failed' }); }
});

app.post('/api/receipt-ocr', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image element payload detected.' });
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const receiptImageBufferPart = { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } };
        const prompt = `Analyze this complex receipt/bill image closely. Extract the overall Grand Total amount paid. Return ONLY a valid JSON object in this format: { "total": number }. If no numbers are decipherable, return { "total": 0 }. Do not write markdown wrapping.`;
        const result = await model.generateContent([prompt, receiptImageBufferPart]);
        let cleanText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
        res.status(200).json(JSON.parse(cleanText));
    } catch (error) { res.status(500).json({ error: 'AI Vision decoding exception occurred.' }); }
});

app.post('/api/scrape-price', async (req, res) => {
    const targetUrl = req.body.url;
    if (!targetUrl) return res.status(400).json({ error: 'No URL provided' });
    try {
        let html = "";
        try { html = await fetchPageHtml(targetUrl); } catch(e) {
            const proxyRes = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`);
            html = await proxyRes.text();
        }
        let title = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)?.[1] || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "";
        let imageUrl = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)?.[1] || html.match(/<img[^>]*id="landingImage"[^>]*src="([^"]+)"/i)?.[1] || "";
        let priceMatch = html.match(/(?:₹|Rs\.?|INR)\s*([0-9,]{2,}(?:\.[0-9]{2})?)/i);
        let price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;
        title = title.replace(/Product summary presents key product information/gi, '').split('|')[0].split('- Buy')[0].split('- Price')[0].split(': Amazon')[0].trim();
        if (price === 0 || !title || title.length < 3) {
            try {
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const prompt = `Extract product title and price from URL: "${targetUrl}". Snippet: "${html.substring(0, 2000).replace(/"/g, "'")}". Return strictly JSON: {"title":"[Title]","price": [number]}`;
                const aiRes = await model.generateContent(prompt);
                const jsonMatch = aiRes.response.text().match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const aiJson = JSON.parse(jsonMatch[0]);
                    if (aiJson.title && (title.length < 3 || title.includes("Amazon"))) title = aiJson.title;
                    if (aiJson.price && price === 0) price = parseFloat(aiJson.price);
                }
            } catch(e) {}
        }
        res.status(200).json({ title: title || 'Saved Product', price: price || 0, imageUrl: imageUrl, link: targetUrl });
    } catch (error) { res.status(500).json({ error: 'Scraping failed completely' }); }
});

app.post('/api/scrape-media', async (req, res) => {
    const targetUrl = req.body.url;
    if (!targetUrl) return res.status(400).json({ error: 'No URL provided' });
    const imdbIdMatch = targetUrl.match(/tt\d+/i);
    const imdbId = imdbIdMatch ? imdbIdMatch[0] : null;
    try {
        let html = "";
        try { html = await fetchPageHtml(targetUrl); } catch(e) {
            const proxyRes = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`);
            html = await proxyRes.text();
        }
        let title = "", imageUrl = "", description = "", details = "", mediaType = "Movie", rating = "5", genre = "Other", price = 0;
        const ogTitle = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i)?.[1] || html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "";
        const ogImage = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i)?.[1] || "";
        const ogDesc = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i)?.[1] || html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1] || "";
        title = ogTitle; imageUrl = ogImage; description = ogDesc;

        if (/book|goodreads|isbn|author|pages/i.test(targetUrl + title + description)) mediaType = 'Book';
        else if (/series|tv|season|episode/i.test(targetUrl + title + description)) mediaType = 'Series';
        if (/anime|myanimelist|crunchyroll/i.test(targetUrl + title + description)) mediaType = 'Anime';

        const jsonLdMatches = html.match(/<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
        if (jsonLdMatches) {
            for (let block of jsonLdMatches) {
                try {
                    let cleanBlock = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '').trim();
                    let parsed = JSON.parse(cleanBlock);
                    let items = Array.isArray(parsed) ? parsed : [parsed];
                    for (let item of items) {
                        const nodes = item['@graph'] ? item['@graph'] : [item];
                        for (let node of nodes) {
                            if (imdbId && node.url && !node.url.includes(imdbId)) continue; 
                            if (['Movie', 'TVSeries', 'TVEpisode', 'Book', 'Product', 'CreativeWork'].includes(node['@type']) || node.name) {
                                if (node.name) title = node.name;
                                if (node.image) imageUrl = typeof node.image === 'string' ? node.image : (node.image.url || node.image[0] || imageUrl);
                                if (node.aggregateRating?.ratingValue) {
                                    const s = parseFloat(node.aggregateRating.ratingValue);
                                    rating = s >= 8.5 ? '5' : s >= 7.5 ? '4' : s >= 6.5 ? '3' : s >= 5.0 ? '2' : '1';
                                    details += `⭐ ${s}/10`;
                                }
                                if (node.duration) {
                                    const durMatch = String(node.duration).match(/PT(?:(\d+)H)?(?:(\d+)M)?/i);
                                    if (durMatch) {
                                        const h = durMatch[1] ? `${durMatch[1]}h` : '';
                                        const m = durMatch[2] ? `${durMatch[2]}m` : '';
                                        const dStr = `⏱️ ${h} ${m}`.trim();
                                        details += details ? ` • ${dStr}` : dStr;
                                    }
                                }
                                if (node.genre) genre = (Array.isArray(node.genre) ? node.genre : [node.genre])[0].split(',')[0].trim();
                                if (node.numberOfPages) details += details ? ` • 📖 ${node.numberOfPages} pages` : `📖 ${node.numberOfPages} pages`;
                            }
                        }
                    }
                } catch(e) {}
            }
        }
        title = title.replace(/\(TV Series.*?\)/gi, '').replace(/\(Movie.*?\)/gi, '').replace(/- IMDb/gi, '').split('|')[0].trim();

        if (!title || title.length < 2 || title.includes("Access Denied") || title.includes("Robot Check")) {
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const prompt = `Extract movie/book details for URL: "${targetUrl}". Known IMDb ID: ${imdbId || 'Unknown'}. HTML snippet: "${html.substring(0, 3000).replace(/"/g, "'")}". Return strictly JSON: {"title":"[Name]","imageUrl":"[Poster URL]","mediaType":"Movie|Book|Series|Anime","genre":"Action|Comedy|Drama|Sci-Fi|Other","details":"[e.g. 2h 15m or 320 pages]","mediaRating":"5"}`;
            const aiRes = await model.generateContent(prompt);
            const jsonMatch = aiRes.response.text().match(/\{[\s\S]*\}/);
            if (jsonMatch) return res.status(200).json(JSON.parse(jsonMatch[0]));
        }
        return res.status(200).json({ title: title || 'Saved Media', imageUrl, mediaType, details, genre, mediaRating: rating, price });
    } catch (error) { res.status(500).json({ error: 'Media scraping completely failed' }); }
});

app.get('/api/bookmark-media', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.send("No URL provided.");
    res.send(`<html style="background:#050505; color:#a855f7; font-family:sans-serif; text-align:center; padding:2rem;"><h2 style="margin-top: 20px; color:#a855f7;">🎬 Media Vault</h2><div id="manualEntryBox" style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 16px; margin-top: 20px; border: 1px solid rgba(255,255,255,0.1);"><input type="text" id="manualName" placeholder="Movie / Book Name" style="background: rgba(0,0,0,0.5); color: #fff; font-size: 16px; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 15px; width: 100%; outline: none; margin-bottom: 10px;"><select id="mediaType" style="background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 12px; width: 100%; outline: none; margin-bottom: 10px;"><option value="Movie">🎬 Movie</option><option value="Book">📚 Book</option><option value="Series">📺 Series</option><option value="Anime">🎌 Anime</option></select><select id="mediaGenre" style="background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 12px; width: 100%; outline: none; margin-bottom: 15px;"><option value="Action">Action</option><option value="Comedy">Comedy</option><option value="Drama">Drama</option><option value="Sci-Fi">Sci-Fi</option><option value="Romance">Romance</option><option value="Other">Other</option></select><button onclick="saveManualData()" style="background: #9333ea; color: white; border: none; padding: 15px; width: 100%; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer; transition: 0.2s;">Save to Vault</button></div><script>function saveManualData() { const btn = document.querySelector('button'); btn.innerText = "Syncing to Cloud..."; btn.style.background = "#10b981"; fetch('https://wallet-y7yv.onrender.com/api/add-wishlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: String(Date.now()), title: document.getElementById('manualName').value || 'Saved Media', price: 0, link: '${targetUrl}', imageUrl: '', category: 'MEDIA NODE', wishCategory: document.getElementById('mediaType').value, mediaGenre: document.getElementById('mediaGenre').value, mediaStatus: 'Planned', isMedia: true, timestamp: Date.now() }) }).then(() => { document.getElementById('manualEntryBox').innerHTML = '<h1 style="color:#10b981; font-size: 30px; margin: 30px 0;">Saved! 🎬</h1>'; setTimeout(() => window.close(), 1500); }); }</script></html>`);
});

app.get('/api/bookmark-media-auto', async (req, res) => {
    const { title, link, img, cat } = req.query;
    if (!link) return res.send("Error: Missing parameters.");
    let mediaType = "Movie";
    if (/book|goodreads/i.test(link + cat)) mediaType = "Book";
    else if (/anime|crunchyroll|myanimelist/i.test(link + cat)) mediaType = "Anime";
    const item = { id: String(Date.now()), title: title ? decodeURIComponent(title) : 'Saved Media', price: 0, link: decodeURIComponent(link), imageUrl: img ? decodeURIComponent(img) : '', category: 'MEDIA NODE', wishCategory: mediaType, mediaGenre: 'Other', mediaStatus: 'Planned', isMedia: true, timestamp: Date.now() };
    try { await db.collection('wishlist').doc(item.id).set(item); res.send(`<script>window.close();</script>`); } catch(err) { res.send("Database error."); }
});

app.get('/api/bookmark-auto', async (req, res) => {
    const { title, price, link, img, cat } = req.query;
    if (!link || !price) return res.send("Error: Missing parameters.");
    let hostname = 'ONLINE';
    try { hostname = new URL(link).hostname.replace('www.', '').split('.')[0].toUpperCase(); } catch(e) {}
    const item = { id: String(Date.now()), title: title ? decodeURIComponent(title) : 'Saved Item', price: parseFloat(price) || 0, link: decodeURIComponent(link), imageUrl: img ? decodeURIComponent(img) : '', category: cat ? decodeURIComponent(cat) : hostname, wishCategory: 'Other', timestamp: Date.now() };
    try { await db.collection('wishlist').doc(item.id).set(item); res.send(`<script>window.close();</script>`); } catch(err) { res.send("Database error."); }
});

app.get('/api/bookmark', async (req, res) => {
    const targetUrl = req.query.url;
    res.send(`<html style="background:#050505; color:#10b981; font-family:sans-serif; text-align:center; padding:2rem;"><div id="manualEntryBox" style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 16px; margin-top: 20px; border: 1px solid rgba(255,255,255,0.1);"><input type="text" id="manualName" placeholder="Product Name" style="background: rgba(0,0,0,0.5); color: #fff; font-size: 16px; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 15px; width: 100%; outline: none; margin-bottom: 10px;"><input type="number" id="manualPrice" placeholder="Enter Price (₹)" style="background: rgba(0,0,0,0.5); color: #10b981; font-size: 24px; font-weight: bold; text-align: center; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 15px; width: 100%; outline: none; margin-bottom: 15px;" autofocus><button onclick="saveManualData()" style="background: #3b82f6; color: white; border: none; padding: 15px; width: 100%; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer; transition: 0.2s;">Save to Tracker</button></div><script>function saveManualData() { const btn = document.querySelector('button'); const priceInput = document.getElementById('manualPrice').value; if (!priceInput || priceInput <= 0) return; btn.innerText = "Syncing..."; btn.style.background = "#10b981"; fetch('https://wallet-y7yv.onrender.com/api/add-wishlist', { method:'POST', headers:{'Content-Type': 'application/json'}, body:JSON.stringify({ id: String(Date.now()), title: document.getElementById('manualName').value || 'Saved Item', price: parseFloat(priceInput), link: '${targetUrl}', imageUrl: '', category: 'MANUAL', wishCategory: 'Other', timestamp: Date.now() }) }).then(() => { document.getElementById('manualEntryBox').innerHTML = '<h2>Saved!</h2>'; setTimeout(() => window.close(), 1500); }).catch(() => { btn.innerText = "Save Failed"; btn.style.background = "#ef4444"; }); }</script></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));