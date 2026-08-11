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
app.use(express.json({ limit: '50mb' }));

const upload = multer({ storage: multer.memoryStorage() });

const apiKey = process.env.GEMINI_API_KEY || "YOUR_API_KEY_HERE";
const genAI = new GoogleGenerativeAI(apiKey);

// ============================================================
// FIREBASE INITIALIZATION
// ============================================================
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

// ============================================================
// HELPER FUNCTIONS
// ============================================================
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

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/api/ping', (req, res) => res.status(200).send('OK'));

// ============================================================
// TRANSACTION DATABASE ROUTES
// ============================================================
app.get('/api/get-transactions', async (req, res) => {
    try {
        const snapshot = await db.collection('transactions').get();
        res.status(200).json(snapshot.docs.map(doc => doc.data()));
    } catch (error) {
        console.error("GET TRANSACTIONS ERROR:", error);
        res.status(500).json({ error: 'Failed to fetch transactions' });
    }
});

app.post('/api/add-transaction', async (req, res) => {
    try {
        const transaction = req.body;
        if (!transaction || !transaction.id) return res.status(400).json({ error: 'Transaction ID is required' });
        await db.collection('transactions').doc(String(transaction.id)).set(transaction);
        res.status(201).json({ message: 'Transaction added successfully', transaction });
    } catch (error) {
        console.error("ADD TRANSACTION ERROR:", error);
        res.status(500).json({ error: 'Failed to add transaction' });
    }
});

app.delete('/api/delete-transaction/:id', async (req, res) => {
    try {
        await db.collection('transactions').doc(String(req.params.id)).delete();
        res.status(200).json({ message: 'Transaction deleted successfully' });
    } catch (error) {
        console.error("DELETE TRANSACTION ERROR:", error);
        res.status(500).json({ error: 'Failed to delete transaction' });
    }
});

app.put('/api/edit-transaction/:id', async (req, res) => {
    try {
        await db.collection('transactions').doc(String(req.params.id)).update(req.body);
        res.status(200).json({ message: 'Transaction updated successfully' });
    } catch (error) {
        console.error("EDIT TRANSACTION ERROR:", error);
        res.status(500).json({ error: 'Failed to update transaction' });
    }
});

app.post('/api/sync-transactions', async (req, res) => {
    try {
        const transactions = req.body;
        if (!Array.isArray(transactions)) return res.status(400).json({ error: 'Expected an array of transactions' });
        const chunks = [];
        for (let i = 0; i < transactions.length; i += 450) chunks.push(transactions.slice(i, i + 450));
        
        for (const chunk of chunks) {
            const batch = db.batch();
            chunk.forEach(tx => {
                if (!tx || !tx.id) return;
                batch.set(db.collection('transactions').doc(String(tx.id)), tx);
            });
            await batch.commit();
        }
        res.status(200).json({ message: 'Transaction sync complete', count: transactions.length });
    } catch (error) {
        console.error("SYNC TRANSACTIONS ERROR:", error);
        res.status(500).json({ error: 'Failed to sync transactions' });
    }
});

// ============================================================
// PROTECTED TRANSACTION BACKUP (New Feature Retained)
// ============================================================
app.post('/api/backup-transactions', async (req, res) => {
    try {
        const transactions = Array.isArray(req.body.transactions) ? req.body.transactions : [];
        if (transactions.length === 0) return res.status(400).json({ error: 'Backup refused: empty transaction list' });
        
        const payload = { transactions, createdAt: Date.now(), source: req.body.source || 'Wallet Mark 2', version: 2 };
        await db.collection('settings').doc('transactionBackupLatest').set(payload);
        res.status(200).json({ message: 'Protected transaction backup saved', count: transactions.length, createdAt: payload.createdAt });
    } catch (error) {
        console.error("BACKUP TRANSACTIONS ERROR:", error);
        res.status(500).json({ error: 'Failed to backup transactions' });
    }
});

app.get('/api/get-transaction-backup', async (req, res) => {
    try {
        const document = await db.collection('settings').doc('transactionBackupLatest').get();
        if (!document.exists) return res.status(404).json({ error: 'No protected transaction backup found' });
        res.status(200).json(document.data());
    } catch (error) {
        console.error("GET BACKUP ERROR:", error);
        res.status(500).json({ error: 'Failed to read transaction backup' });
    }
});

app.get('/api/transaction-status', async (req, res) => {
    try {
        const transactionSnapshot = await db.collection('transactions').get();
        const backupDocument = await db.collection('settings').doc('transactionBackupLatest').get();
        let backupData = backupDocument.exists ? backupDocument.data() : {};
        
        res.status(200).json({
            transactionCount: transactionSnapshot.size,
            backupCount: Array.isArray(backupData.transactions) ? backupData.transactions.length : 0,
            backupCreatedAt: backupData.createdAt || null
        });
    } catch (error) {
        console.error("TRANSACTION STATUS ERROR:", error);
        res.status(500).json({ error: 'Failed to read transaction status' });
    }
});

// ============================================================
// WISHLIST ROUTES
// ============================================================
app.get('/api/get-wishlist', async (req, res) => {
    try {
        const snapshot = await db.collection('wishlist').get();
        res.status(200).json(snapshot.docs.map(doc => doc.data()));
    } catch (error) { res.status(500).json({ error: 'Failed to fetch wishlist' }); }
});

app.post('/api/add-wishlist', async (req, res) => {
    try {
        const item = req.body;
        if (!item || !item.id) return res.status(400).json({ error: 'Wishlist item ID is required' });
        await db.collection('wishlist').doc(String(item.id)).set(item);
        res.status(201).json({ message: 'Wishlist item added successfully' });
    } catch (error) { res.status(500).json({ error: 'Failed to add wishlist item' }); }
});

app.delete('/api/delete-wishlist/:id', async (req, res) => {
    try {
        await db.collection('wishlist').doc(String(req.params.id)).delete();
        res.status(200).json({ message: 'Wishlist item deleted' });
    } catch (error) { res.status(500).json({ error: 'Failed to delete wishlist item' }); }
});

app.post('/api/sync-wishlist', async (req, res) => {
    try {
        const items = req.body;
        if (!Array.isArray(items)) return res.status(400).json({ error: 'Expected an array' });
        
        const chunks = [];
        for (let i = 0; i < items.length; i += 450) chunks.push(items.slice(i, i + 450));
        
        for (const chunk of chunks) {
            const batch = db.batch();
            chunk.forEach(item => {
                if (!item || !item.id) return;
                batch.set(db.collection('wishlist').doc(String(item.id)), item);
            });
            await batch.commit();
        }
        res.status(200).json({ message: 'Wishlist sync complete', count: items.length });
    } catch (error) { res.status(500).json({ error: 'Failed to sync wishlist' }); }
});

// ============================================================
// WORKSPACE CLOUD SYNC
// ============================================================
app.get('/api/get-workspace', async (req, res) => {
    try {
        const document = await db.collection('settings').doc('workspaceData').get();
        if (document.exists) res.status(200).json(document.data());
        else res.status(200).json({ notes: '', whiteboard: '' });
    } catch (error) { res.status(500).json({ error: 'Failed to fetch workspace' }); }
});

app.post('/api/save-workspace', async (req, res) => {
    try {
        await db.collection('settings').doc('workspaceData').set(req.body);
        res.status(200).json({ message: 'Workspace synced securely to cloud' });
    } catch (error) { res.status(500).json({ error: 'Failed to sync workspace' }); }
});

// ============================================================
// C.A.S.P.E.R. AI — FINANCIAL ADVICE
// ============================================================
app.post('/api/jarvis-advice', async (req, res) => {
    try {
        const { transactions, monthlyBudget } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `You are C.A.S.P.E.R. (Calculated Asset Security and Personal Expense Recorder), a sharp, highly intelligent personal financial assistant for Vidhun. 
        Analyze these transactions: ${JSON.stringify(transactions)}. 
        The user's monthly budget is ₹${monthlyBudget}. 
        Provide a quick conversational financial summary, followed by ONE highly actionable piece of advice. 
        STRICT RULES: 1. Speak directly to Vidhun. 2. Use a cool, precise tone. 3. DO NOT use markdown formatting. 4. Keep it to 3-4 short sentences total. 5. Use normal line breaks to separate the summary from the advice.`;

        const result = await model.generateContent(prompt);
        res.status(200).json({ advice: result.response.text() });
    } catch (error) {
        console.error("CASPER ADVICE ERROR:", error);
        res.status(500).json({ error: 'Failed to generate advice' });
    }
});

// ============================================================
// C.A.S.P.E.R. AI — PREDICTION
// ============================================================
app.post('/api/jarvis-predict', async (req, res) => {
    try {
        const { currentMonthData, previousMonthData, currentBudget } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
        const prompt = `You are C.A.S.P.E.R. (Calculated Asset Security and Personal Expense Recorder), an elite predictive financial AI for Vidhun.
        Your goal is to correlate Vidhun's previous month's spending patterns with the current month's trajectory, predict the end-of-month expense, and tell him exactly where to cut back.
        
        DATA INPUTS:
        Previous Month Transactions: ${JSON.stringify(previousMonthData)}
        Current Month Transactions: ${JSON.stringify(currentMonthData)}
        Vidhun's Target Budget: ₹${currentBudget}

        YOUR TASK: Write a hyper-focused HTML forecast. Do NOT wrap the answer in markdown fences.
        Use these exact Tailwind classes:
        Headings: <h2 class="text-sm font-black text-purple-400 mb-2 mt-4 uppercase tracking-widest border-b border-white/10 pb-1">
        Paragraphs: <p class="mb-3 text-sm text-gray-300">
        Highlighted Targets: <span class="text-rose-400 font-bold">
        Safe Targets: <span class="text-emerald-400 font-bold">
        Lists: <ul class="list-disc pl-5 mb-3 text-gray-300 space-y-2 text-sm">

        STRUCTURE: 1. Correlation Analysis 2. EOM Prediction 3. The Cut List`;

        const result = await model.generateContent(prompt);
        res.status(200).json({ prediction: result.response.text().replace(/```html/gi, '').replace(/```/g, '').trim() });
    } catch (error) {
        console.error("CASPER PREDICT ERROR:", error);
        res.status(500).json({ error: 'Failed to generate prediction' });
    }
});

// ============================================================
// C.A.S.P.E.R. REPORT (Fixed Variables)
// ============================================================
app.post('/api/jarvis-report', async (req, res) => {
    try {
        const { compiledMonths, monthlyBudget, selectedMonth } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
        const prompt = `You are C.A.S.P.E.R., Vidhun's personal financial intelligence system.
        Analyze the supplied multi-month transaction data.

        MONTH-BY-MONTH BREAKDOWN: ${JSON.stringify(compiledMonths)}
        CURRENT FILTER MONTH: ${selectedMonth}
        MONTHLY BUDGET: ₹${monthlyBudget}

        Create a structured HTML financial report. Include:
        - Overall financial performance
        - Monthly comparison
        - Income analysis
        - Expense analysis
        - Category trends
        - Savings performance
        - Unusual spending
        - Practical recommendations

        Return HTML only. Do not use markdown fences.`;

        const result = await model.generateContent(prompt);
        res.status(200).json({ report: result.response.text().replace(/```html/gi, '').replace(/```/g, '').trim() });
    } catch (error) {
        console.error("CASPER REPORT ERROR:", error);
        res.status(500).json({ error: 'Failed to generate report' });
    }
});

// ============================================================
// RECEIPT OCR SCANNER (Restored)
// ============================================================
app.post('/api/receipt-ocr', upload.single('receipt'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No image element payload detected.' });
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const receiptImageBufferPart = { inlineData: { data: req.file.buffer.toString("base64"), mimeType: req.file.mimetype } };
        const prompt = `Analyze this complex receipt/bill image closely. Extract the overall Grand Total amount paid. Return ONLY a valid JSON object in this format: { "total": number }. If no numbers are decipherable, return { "total": 0 }. Do not write markdown wrapping.`;

        const result = await model.generateContent([prompt, receiptImageBufferPart]);
        let cleanText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
        res.status(200).json(JSON.parse(cleanText));
    } catch (error) { 
        console.error("OCR ERROR:", error);
        res.status(500).json({ error: 'AI Vision decoding exception occurred.' }); 
    }
});

// ============================================================
// SMS PARSING (Fixed smsText match)
// ============================================================
app.post('/api/sms-webhook', async (req, res) => {
    try {
        const sms = req.body.smsText || req.body.sms || req.body.message || req.body.text || '';
        if (!sms.trim()) return res.status(400).json({ error: 'SMS text is required' });

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `You are C.A.S.P.E.R., a banking SMS parser. Parse this Indian banking SMS: "${sms}"
        Extract the actual transaction.
        IMPORTANT: Ignore "Available Balance", "Avl Bal", and account balance figures. Extract only the actual debited or credited amount. Identify merchant, date, income/expense, and suggest category.
        Return ONLY valid JSON: {"type": "income|expense", "amount": 0, "merchant": "", "date": "", "category": ""}`;

        const result = await model.generateContent(prompt);
        const match = result.response.text().match(/\{[\s\S]*\}/);
        if (!match) return res.status(500).json({ error: 'Could not parse SMS' });
        
        const parsed = JSON.parse(match[0]);
        const transaction = {
            id: String(Date.now()) + Math.random().toString(36).slice(2, 8),
            type: parsed.type === 'income' ? 'income' : 'expense',
            amount: Number(parsed.amount) || 0,
            account: 'UPI',
            category: parsed.category || 'Other',
            note: parsed.merchant ? `${parsed.merchant} (SMS)` : '(SMS)',
            timestamp: parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now(),
            isRecurring: false
        };

        await db.collection('pending').doc(transaction.id).set(transaction);
        res.status(200).json({ message: 'Transaction sent to C.A.S.P.E.R. queue', transaction });
    } catch (error) {
        console.error("SMS WEBHOOK ERROR:", error);
        res.status(500).json({ error: 'Failed to parse SMS' });
    }
});

// ============================================================
// BULK SMS (Fixed logic for bulk string)
// ============================================================
app.post('/api/bulk-sms', async (req, res) => {
    try {
        const bulkText = req.body.bulkText;
        if (!bulkText) return res.status(400).json({ error: 'No bulk text provided' });

        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `Analyze this large block of text containing multiple historical bank SMS messages: "${bulkText}"
        Extract EVERY valid transaction. Ignore OTPs. Extract EXACT debited/credited amount (NEVER the 'Available Balance').
        Return ONLY a JSON array of objects: [{"amount": 500, "merchant": "Swiggy", "date": "YYYY-MM-DD", "type": "expense", "category": "Food & Dining"}]`;

        const result = await model.generateContent(prompt);
        const match = result.response.text().match(/\[[\s\S]*\]/);
        if (!match) return res.status(500).json({ error: 'No JSON array returned' });

        const parsedArray = JSON.parse(match[0]);
        const results = [];
        const batch = db.batch();

        for (const parsed of parsedArray) {
            if (parsed.amount > 0) {
                const transaction = {
                    id: String(Date.now()) + Math.random().toString(36).slice(2, 8),
                    type: parsed.type === 'income' ? 'income' : 'expense',
                    amount: Number(parsed.amount) || 0,
                    account: 'UPI',
                    category: parsed.category || 'Other',
                    note: parsed.merchant ? `${parsed.merchant} (Bulk SMS)` : '(Bulk SMS)',
                    timestamp: parsed.date ? Date.parse(parsed.date) || Date.now() : Date.now(),
                    isRecurring: false
                };
                batch.set(db.collection('pending').doc(transaction.id), transaction);
                results.push(transaction);
            }
        }
        await batch.commit();

        res.status(200).json({ message: 'Bulk SMS processing complete', count: results.length, transactions: results });
    } catch (error) {
        console.error("BULK SMS ERROR:", error);
        res.status(500).json({ error: 'Failed to process bulk SMS' });
    }
});

// ============================================================
// C.A.S.P.E.R. PENDING QUEUE
// ============================================================
app.get('/api/pending', async (req, res) => {
    try {
        const snapshot = await db.collection('pending').get();
        res.status(200).json(snapshot.docs.map(doc => doc.data()));
    } catch (error) { res.status(500).json({ error: 'Failed to fetch pending transactions' }); }
});

app.post('/api/approve', async (req, res) => {
    try {
        const id = String(req.body.id);
        if (!id) return res.status(400).json({ error: 'Transaction ID required' });
        
        const pendingRef = db.collection('pending').doc(id);
        const pendingDoc = await pendingRef.get();
        if (!pendingDoc.exists) return res.status(404).json({ error: 'Pending transaction not found' });
        
        const transaction = pendingDoc.data();
        await db.collection('transactions').doc(id).set(transaction);
        await pendingRef.delete();
        
        res.status(200).json({ message: 'Transaction approved', transaction });
    } catch (error) { res.status(500).json({ error: 'Failed to approve transaction' }); }
});

app.post('/api/reject', async (req, res) => {
    try {
        const id = String(req.body.id);
        if (!id) return res.status(400).json({ error: 'Transaction ID required' });
        await db.collection('pending').doc(id).delete();
        res.status(200).json({ message: 'Transaction rejected' });
    } catch (error) { res.status(500).json({ error: 'Failed to reject transaction' }); }
});

// ============================================================
// PRICE SCRAPER
// ============================================================
app.post('/api/scrape-price', async (req, res) => {
    try {
        const targetUrl = req.body.url;
        if (!targetUrl) return res.status(400).json({ error: 'URL required' });

        let html = '';
        try {
            html = await fetchPageHtml(targetUrl);
        } catch (directError) {
            console.log("Direct scrape failed, trying proxy...");
            try {
                const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(targetUrl);
                const response = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
                html = await response.text();
            } catch (proxyError) { console.log("Proxy scraping failed."); }
        }

        let title = '', price = 0, imageUrl = '';
        const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
        if (ogTitle) title = ogTitle[1];

        const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        if (ogImage) imageUrl = ogImage[1];

        const pricePatterns = [/₹\s?([\d,]+(?:\.\d{1,2})?)/i, /INR\s?([\d,]+(?:\.\d{1,2})?)/i, /"price"\s*:\s*"([\d,]+(?:\.\d{1,2})?)"/i, /"price"\s*:\s*([\d,]+(?:\.\d{1,2})?)/i];
        for (const pattern of pricePatterns) {
            const match = html.match(pattern);
            if (match) { price = parseFloat(match[1].replace(/,/g, '')); break; }
        }

        if (!title || !price) {
            try {
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const prompt = `Extract product information from this URL: ${targetUrl}\nHTML:\n${html.substring(0, 12000)}\nReturn ONLY valid JSON: {"title":"", "price":0, "imageUrl":"", "category":""}`;
                const result = await model.generateContent(prompt);
                const match = result.response.text().match(/\{[\s\S]*\}/);
                if (match) {
                    const aiData = JSON.parse(match[0]);
                    title = aiData.title || title;
                    price = Number(aiData.price) || price;
                    imageUrl = aiData.imageUrl || imageUrl;
                }
            } catch (aiError) { console.error("PRICE AI FALLBACK ERROR:", aiError); }
        }

        res.status(200).json({ title: title || 'Saved Product', price: price || 0, imageUrl: imageUrl || '', link: targetUrl });
    } catch (error) {
        console.error("PRICE SCRAPER ERROR:", error);
        res.status(500).json({ error: 'Price scraping failed' });
    }
});

// ============================================================
// MEDIA SCRAPER
// ============================================================
app.post('/api/scrape-media', async (req, res) => {
    try {
        const targetUrl = req.body.url;
        if (!targetUrl) return res.status(400).json({ error: 'URL required' });

        let html = '';
        try {
            html = await fetchPageHtml(targetUrl);
        } catch (error) {
            try {
                const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(targetUrl);
                const response = await fetch(proxyUrl);
                html = await response.text();
            } catch (proxyError) { html = ''; }
        }

        let title = '', imageUrl = '', mediaType = 'Movie', genre = 'Other', details = '', rating = '5';
        const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
        if (ogTitle) title = ogTitle[1];
        
        const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        if (ogImage) imageUrl = ogImage[1];

        const jsonLdMatches = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
        for (const block of jsonLdMatches) {
            try {
                const jsonText = block.replace(/<script[^>]*>/i, '').replace(/<\/script>/i, '');
                const data = JSON.parse(jsonText);
                const nodes = Array.isArray(data) ? data : [data];
                for (const node of nodes) {
                    if (!title && node.name) title = node.name;
                    if (!imageUrl && node.image) imageUrl = Array.isArray(node.image) ? node.image[0] : typeof node.image === 'object' ? node.image.url : node.image;
                    if (node.aggregateRating && node.aggregateRating.ratingValue) rating = String(node.aggregateRating.ratingValue);
                    if (node.genre) genre = Array.isArray(node.genre) ? node.genre[0] : node.genre;
                    if (node.duration) details = node.duration;
                    if (node.numberOfPages) details = details ? `${details} • 📖 ${node.numberOfPages} pages` : `📖 ${node.numberOfPages} pages`;
                }
            } catch (error) {}
        }

        if (/goodreads|book/i.test(targetUrl)) mediaType = 'Book';
        else if (/anime|crunchyroll|myanimelist/i.test(targetUrl)) mediaType = 'Anime';
        else if (/tv|series|show/i.test(targetUrl)) mediaType = 'Series';

        title = title.replace(/\(TV Series.*?\)/gi, '').replace(/\(Movie.*?\)/gi, '').replace(/- IMDb/gi, '').split('|')[0].trim();

        if (!title || title.length < 2 || title.includes('Access Denied') || title.includes('Robot Check')) {
            try {
                const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
                const prompt = `Extract movie/book details. URL: "${targetUrl}". HTML context: "${html.substring(0, 3000).replace(/"/g, "'")}". Return strictly valid JSON: {"title":"", "imageUrl":"", "mediaType":"Movie|Book|Series|Anime", "genre":"Action|Comedy|Drama|Sci-Fi|Other", "details":"", "mediaRating":"5"}`;
                const aiRes = await model.generateContent(prompt);
                const jsonMatch = aiRes.response.text().match(/\{[\s\S]*\}/);
                if (jsonMatch) return res.status(200).json(JSON.parse(jsonMatch[0]));
            } catch (error) { console.error("MEDIA AI FALLBACK ERROR:", error); }
        }

        res.status(200).json({ title: title || 'Saved Media', imageUrl: imageUrl || '', mediaType, details, genre, mediaRating: rating, price: 0 });
    } catch (error) {
        console.error("MEDIA SCRAPER ERROR:", error);
        res.status(500).json({ error: 'Media scraping completely failed' });
    }
});

// ============================================================
// BOOKMARKLET ROUTES
// ============================================================
app.get('/api/bookmark-media', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.send("No URL provided.");
    res.send(`
<html style="background:#050505; color:#a855f7; font-family:sans-serif; text-align:center; padding:2rem;">
<h2 style="margin-top:20px; color:#a855f7;">🎬 Media Vault</h2>
<div id="manualEntryBox" style="background:rgba(255,255,255,0.05); padding:20px; border-radius:16px; margin-top:20px; border:1px solid rgba(255,255,255,0.1);">
<input type="text" id="manualName" placeholder="Movie / Book Name" style="background:rgba(0,0,0,0.5); color:#fff; font-size:16px; border:1px solid rgba(255,255,255,0.2); border-radius:12px; padding:15px; width:100%; outline:none; margin-bottom:10px;">
<select id="mediaType" style="background:rgba(0,0,0,0.5); color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:12px; padding:12px; width:100%; outline:none; margin-bottom:10px;">
<option value="Movie">🎬 Movie</option><option value="Book">📚 Book</option><option value="Series">📺 Series</option><option value="Anime">🎌 Anime</option>
</select>
<select id="mediaGenre" style="background:rgba(0,0,0,0.5); color:#fff; border:1px solid rgba(255,255,255,0.2); border-radius:12px; padding:12px; width:100%; outline:none; margin-bottom:15px;">
<option value="Action">Action</option><option value="Comedy">Comedy</option><option value="Drama">Drama</option><option value="Sci-Fi">Sci-Fi</option><option value="Romance">Romance</option><option value="Other">Other</option>
</select>
<button onclick="saveManualData()" style="background:#9333ea; color:white; border:none; padding:15px; width:100%; border-radius:12px; font-size:16px; font-weight:bold; cursor:pointer;">Save to Vault</button>
</div>
<script>
function saveManualData() {
    const btn = document.querySelector('button');
    const nameInput = document.getElementById('manualName').value || 'Saved Media';
    const typeInput = document.getElementById('mediaType').value;
    const genreInput = document.getElementById('mediaGenre').value;
    btn.innerText = "Syncing to Cloud..."; btn.style.background = "#10b981";
    fetch('https://wallet-y7yv.onrender.com/api/add-wishlist', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ id: String(Date.now()), title: nameInput, price:0, link: '${targetUrl}', imageUrl:'', category: 'MEDIA NODE', wishCategory: typeInput, mediaGenre: genreInput, mediaStatus: 'Planned', isMedia:true, timestamp: Date.now() })
    }).then(() => {
        document.getElementById('manualEntryBox').innerHTML = '<h1 style="color:#10b981;font-size:30px;margin:30px 0;">Saved! 🎬</h1>';
        setTimeout(() => window.close(), 1500);
    }).catch(() => { btn.innerText = "Save Failed"; btn.style.background = "#ef4444"; });
}
</script>
</html>`);
});

app.get('/api/bookmark-media-auto', async (req, res) => {
    const { title, link, img, cat } = req.query;
    if (!link) return res.send("Error: Missing parameters.");
    let mediaType = 'Movie';
    if (/book|goodreads/i.test(link + cat)) mediaType = 'Book';
    else if (/anime|crunchyroll|myanimelist/i.test(link + cat)) mediaType = 'Anime';

    const item = { id: String(Date.now()), title: title ? decodeURIComponent(title) : 'Saved Media', price: 0, link: decodeURIComponent(link), imageUrl: img ? decodeURIComponent(img) : '', category: 'MEDIA NODE', wishCategory: mediaType, mediaGenre: 'Other', mediaStatus: 'Planned', isMedia: true, timestamp: Date.now() };
    try {
        await db.collection('wishlist').doc(item.id).set(item);
        res.send(`<script>window.close();</script>`);
    } catch (error) { res.send("Database error."); }
});

app.get('/api/bookmark-auto', async (req, res) => {
    const { title, price, link, img, cat } = req.query;
    if (!link || !price) return res.send("Error: Missing parameters.");
    let hostname = 'ONLINE';
    try { hostname = new URL(link).hostname.replace('www.', '').split('.')[0].toUpperCase(); } catch (error) {}

    const item = { id: String(Date.now()), title: title ? decodeURIComponent(title) : 'Saved Item', price: parseFloat(price) || 0, link: decodeURIComponent(link), imageUrl: img ? decodeURIComponent(img) : '', category: cat ? decodeURIComponent(cat) : hostname, wishCategory: 'Other', timestamp: Date.now() };
    try {
        await db.collection('wishlist').doc(item.id).set(item);
        res.send(`<script>window.close();</script>`);
    } catch (error) { res.send("Database error."); }
});

app.get('/api/bookmark', async (req, res) => {
    const targetUrl = req.query.url;
    res.send(`
<html style="background:#050505; color:#10b981; font-family:sans-serif; text-align:center; padding:2rem;">
<div id="manualEntryBox" style="background:rgba(255,255,255,0.05); padding:20px; border-radius:16px; margin-top:20px; border:1px solid rgba(255,255,255,0.1);">
<input type="text" id="manualName" placeholder="Product Name" style="background:rgba(0,0,0,0.5); color:#fff; font-size:16px; border:1px solid rgba(255,255,255,0.2); border-radius:12px; padding:15px; width:100%; outline:none; margin-bottom:10px;">
<input type="number" id="manualPrice" placeholder="Enter Price (₹)" style="background:rgba(0,0,0,0.5); color:#10b981; font-size:24px; font-weight:bold; text-align:center; border:1px solid rgba(255,255,255,0.2); border-radius:12px; padding:15px; width:100%; outline:none; margin-bottom:15px;" autofocus>
<button onclick="saveManualData()" style="background:#3b82f6; color:white; border:none; padding:15px; width:100%; border-radius:12px; font-size:16px; font-weight:bold; cursor:pointer;">Save to Tracker</button>
</div>
<script>
function saveManualData() {
    const btn = document.querySelector('button');
    const priceInput = document.getElementById('manualPrice').value;
    const nameInput = document.getElementById('manualName').value || 'Saved Item';
    if (!priceInput || priceInput <= 0) return;
    btn.innerText = "Syncing..."; btn.style.background = "#10b981";
    fetch('https://wallet-y7yv.onrender.com/api/add-wishlist', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ id: String(Date.now()), title: nameInput, price: parseFloat(priceInput), link: '${targetUrl}', imageUrl:'', category: 'MANUAL', wishCategory: 'Other', timestamp: Date.now() })
    }).then(() => {
        document.getElementById('manualEntryBox').innerHTML = '<h2>Saved!</h2>';
        setTimeout(() => window.close(), 1500);
    }).catch(() => { btn.innerText = "Save Failed"; btn.style.background = "#ef4444"; });
}
</script>
</html>`);
});

// ============================================================
// SERVER START
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log(`Server running on port ${PORT}`); });