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

// HELPER FOR DIRECT FETCHING WITH REAL DESKTOP BROWSER HEADERS
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

// DETAILED AI FULL MULTI-MONTH REPORT ROUTE
app.post('/api/jarvis-report', async (req, res) => {
    try {
        const { compiledMonths, totalLedger, monthlyBudget, selectedMonth } = req.body;
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        const prompt = `You are a professional financial advisor AI for Vidhun. 
        Vidhun has requested a comprehensive detailed financial report.
        Analyze their entire multi-month financial ledger data to provide a point of view based on their overall trends:
        Month-by-Month breakdown: ${JSON.stringify(compiledMonths)}
        Current selected filter month: ${selectedMonth}
        Monthly budget target: ₹${monthlyBudget}
        
        Write a structured HTML report (do NOT wrap in \`\`\`html, output raw HTML tags).
        Use these exact Tailwind classes for styling:
        - Headers: <h2 class="text-lg font-black text-blue-400 mb-2 mt-4 uppercase tracking-widest">
        - Paragraphs: <p class="mb-3 text-sm text-gray-300">
        - Lists: <ul class="list-disc pl-5 mb-3 text-gray-300 space-y-1">
        - Highlights: <strong class="text-white font-bold">
        
        Structure:
        1. Multi-Month Performance Overview (Compare current period against past months).
        2. Key Spend Drivers & Investment Deductions.
        3. Payment Method Analysis & Daily Burn Velocity.
        4. 3 Actionable Strategic Recommendations to optimize savings.`;

        const result = await model.generateContent(prompt);
        let htmlReport = result.response.text().replace(/```html/gi, '').replace(/```/g, '').trim();
        res.status(200).json({ report: htmlReport });
    } catch (error) { res.status(500).json({ error: 'Failed to generate report' }); }
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
        - Expense ONLY: 'Food & Dining', 'Groceries', 'Transport', 'Utilities', 'Electricity charges', 'Rent', 'Education', 'Travel', 'Shopping', 'Entertainment', 'Health', 'Subscriptions', 'Investments', 'Other'.
        - Income ONLY: 'Salary', 'Freelance', 'Refund', 'Other'.
        
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
        - For expense, choose from ONLY these: 'Food & Dining', 'Groceries', 'Transport', 'Utilities', 'Electricity charges', 'Rent', 'Education', 'Travel', 'Shopping', 'Entertainment', 'Health', 'Subscriptions', 'Investments', 'Other'.
        - For income, choose from: 'Salary', 'Freelance', 'Refund', 'Other'.
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
        let html = "";
        try {
            html = await fetchPageHtml(targetUrl);
        } catch(e) {
            const proxyRes = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`);
            const pData = await proxyRes.json();
            html = pData.contents || "";
        }

        let title = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)?.[1] || 
                    html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "";
        let imageUrl = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)?.[1] || 
                       html.match(/<img[^>]*id="landingImage"[^>]*src="([^"]+)"/i)?.[1] || "";
        let priceMatch = html.match(/(?:₹|Rs\.?|INR)\s*([0-9,]{2,}(?:\.[0-9]{2})?)/i);
        let price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

        title = title.replace(/Product summary presents key product information/gi, '').split('|')[0].split('- Buy')[0].split('- Price')[0].split(': Amazon')[0].trim();

        if (title.length < 3 || title.includes("Amazon.in") || title.includes("Online Shopping") || title.includes("Access Denied")) {
            const urlPath = new URL(targetUrl).pathname.split('/').filter(p => p.length > 2)[0];
            if (urlPath) title = urlPath.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
        }

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

        res.status(200).json({ title: title || 'Saved Product', price: price || 0, imageUrl: imageUrl });
    } catch (error) {
        res.status(500).json({ error: 'Scraping failed completely' });
    }
});

// =======================================================
//   REWRITTEN BLAZING MEDIA SCRAPER (IMDb/Amazon/Goodreads)
// =======================================================
app.post('/api/scrape-media', async (req, res) => {
    const targetUrl = req.body.url;
    if (!targetUrl) return res.status(400).json({ error: 'No URL provided' });

    console.log("🎬 SCRAPING MEDIA URL:", targetUrl);

    // Extract exact IMDb ID if present
    const imdbIdMatch = targetUrl.match(/tt\d+/i);
    const imdbId = imdbIdMatch ? imdbIdMatch[0] : null;

    try {
        let html = "";
        try {
            html = await fetchPageHtml(targetUrl);
        } catch(e) {
            const proxyRes = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(targetUrl)}`);
            const pData = await proxyRes.json();
            html = pData.contents || "";
        }

        let title = "";
        let imageUrl = "";
        let description = "";
        let details = "";
        let mediaType = "Movie";
        let rating = "5";
        let genre = "Other";
        let price = 0;

        const ogTitle = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i)?.[1] || 
                        html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || "";
        const ogImage = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i)?.[1] || "";
        const ogDesc = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i)?.[1] || 
                       html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1] || "";

        title = ogTitle;
        imageUrl = ogImage;
        description = ogDesc;

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
                            const type = node['@type'] || '';
                            // Strictly check if node represents the exact IMDB ID to pull correct data
                            if (imdbId && node.url && !node.url.includes(imdbId)) continue; 

                            if (['Movie', 'TVSeries', 'TVEpisode', 'Book', 'Product', 'CreativeWork'].includes(type) || node.name) {
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

                                if (node.genre) {
                                    const gArr = Array.isArray(node.genre) ? node.genre : [node.genre];
                                    genre = gArr[0].split(',')[0].trim();
                                }

                                if (node.numberOfPages) {
                                    details += details ? ` • 📖 ${node.numberOfPages} pages` : `📖 ${node.numberOfPages} pages`;
                                }
                            }
                        }
                    }
                } catch(e) {}
            }
        }

        title = title.replace(/\(TV Series.*?\)/gi, '').replace(/\(Movie.*?\)/gi, '').replace(/- IMDb/gi, '').split('|')[0].trim();

        if (!title || title.length < 2 || title.includes("Access Denied") || title.includes("Robot Check")) {
            console.log("Extracting media with Gemini AI fallback...");
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const prompt = `Extract movie/book details for URL: "${targetUrl}". The known IMDb ID is: ${imdbId || 'Unknown'}.
            HTML snippet context: "${html.substring(0, 3000).replace(/"/g, "'")}".
            Return strictly valid JSON: {"title":"[Name]","imageUrl":"[Poster URL if found else empty]","mediaType":"Movie|Book|Series|Anime","genre":"Action|Comedy|Drama|Sci-Fi|Isekai|Shounen|Other","details":"[e.g. 2h 15m or 320 pages]","mediaRating":"5"}`;
            
            const aiRes = await model.generateContent(prompt);
            const jsonMatch = aiRes.response.text().match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const aiData = JSON.parse(jsonMatch[0]);
                return res.status(200).json(aiData);
            }
        }

        return res.status(200).json({ title: title || 'Saved Media', imageUrl, mediaType, details, genre, mediaRating: rating, price });

    } catch (error) {
        console.error("Media Scraper Error:", error);
        try {
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
            const prompt = `Guess the movie/series/book title and genre directly from this URL: "${targetUrl}" (IMDb ID: ${imdbId || 'N/A'}). Return JSON: {"title":"[Title]","imageUrl":"","mediaType":"Movie","genre":"Other","details":"","mediaRating":"5"}`;
            const aiRes = await model.generateContent(prompt);
            const jsonMatch = aiRes.response.text().match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                return res.status(200).json(JSON.parse(jsonMatch[0]));
            }
        } catch(aiErr) {}
        res.status(500).json({ error: 'Media scraping completely failed' });
    }
});

// WATCH & READ BOOKMARKLET
app.get('/api/bookmark-media', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.send("No URL provided.");
    res.send(`
        <html style="background:#050505; color:#a855f7; font-family:sans-serif; text-align:center; padding:2rem;">
            <h2 style="margin-top: 20px; color:#a855f7;">🎬 Media Vault</h2>
            <div id="manualEntryBox" style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 16px; margin-top: 20px; border: 1px solid rgba(255,255,255,0.1);">
                <input type="text" id="manualName" placeholder="Movie / Book Name" style="background: rgba(0,0,0,0.5); color: #fff; font-size: 16px; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 15px; width: 100%; outline: none; margin-bottom: 10px;">
                <select id="mediaType" style="background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 12px; width: 100%; outline: none; margin-bottom: 10px;">
                    <option value="Movie">🎬 Movie</option><option value="Book">📚 Book</option><option value="Series">📺 Series</option><option value="Anime">🎌 Anime</option>
                </select>
                <select id="mediaGenre" style="background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 12px; width: 100%; outline: none; margin-bottom: 15px;">
                    <option value="Action">Action</option><option value="Comedy">Comedy</option><option value="Drama">Drama</option><option value="Sci-Fi">Sci-Fi</option><option value="Romance">Romance</option><option value="Shounen">Shounen</option><option value="Isekai">Isekai</option><option value="Other">Other</option>
                </select>
                <button onclick="saveManualData()" style="background: #9333ea; color: white; border: none; padding: 15px; width: 100%; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer; transition: 0.2s;">Save to Vault</button>
            </div>
            <script>
                function saveManualData() {
                    const btn = document.querySelector('button');
                    const nameInput = document.getElementById('manualName').value || 'Saved Media';
                    const typeInput = document.getElementById('mediaType').value;
                    const genreInput = document.getElementById('mediaGenre').value;
                    btn.innerText = "Syncing to Cloud..."; btn.style.background = "#10b981";
                    fetch('https://wallet-y7yv.onrender.com/api/add-wishlist', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: String(Date.now()), title: nameInput, price: 0, link: '${targetUrl}', imageUrl: '', category: 'MEDIA NODE', wishCategory: typeInput, mediaGenre: genreInput, mediaStatus: 'Planned', isMedia: true, timestamp: Date.now() })
                    }).then(() => {
                        document.getElementById('manualEntryBox').innerHTML = '<h1 style="color:#10b981; font-size: 30px; margin: 30px 0;">Saved! 🎬</h1>';
                        setTimeout(() => window.close(), 1500);
                    });
                }
            </script>
        </html>
    `);
});

app.get('/api/bookmark-auto', async (req, res) => {
    const { title, price, link, img, cat } = req.query;
    if (!link || !price) return res.send("Error: Missing parameters.");
    let hostname = 'ONLINE';
    try { hostname = new URL(link).hostname.replace('www.', '').split('.')[0].toUpperCase(); } catch(e) {}

    const safeTitle = title ? decodeURIComponent(title) : 'Saved Item';
    const safeImg = img ? decodeURIComponent(img) : '';
    const safeCat = cat ? decodeURIComponent(cat) : hostname;

    const item = { id: String(Date.now()), title: safeTitle, price: parseFloat(price) || 0, link: decodeURIComponent(link), imageUrl: safeImg, category: safeCat, wishCategory: 'Other', timestamp: Date.now() };
    try {
        await db.collection('wishlist').doc(item.id).set(item);
        res.send(`<script>window.close();</script>`);
    } catch(err) { res.send("Database error."); }
});

app.get('/api/bookmark', async (req, res) => {
    const targetUrl = req.query.url;
    res.send(`
        <html style="background:#050505; color:#10b981; font-family:sans-serif; text-align:center; padding:2rem;">
            <div id="manualEntryBox" style="background: rgba(255,255,255,0.05); padding: 20px; border-radius: 16px; margin-top: 20px; border: 1px solid rgba(255,255,255,0.1);">
                <input type="text" id="manualName" placeholder="Product Name" style="background: rgba(0,0,0,0.5); color: #fff; font-size: 16px; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 15px; width: 100%; outline: none; margin-bottom: 10px;">
                <input type="number" id="manualPrice" placeholder="Enter Price (₹)" style="background: rgba(0,0,0,0.5); color: #10b981; font-size: 24px; font-weight: bold; text-align: center; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; padding: 15px; width: 100%; outline: none; margin-bottom: 15px;" autofocus>
                <button onclick="saveManualData()" style="background: #3b82f6; color: white; border: none; padding: 15px; width: 100%; border-radius: 12px; font-size: 16px; font-weight: bold; cursor: pointer; transition: 0.2s;">Save to Tracker</button>
            </div>
            <script>
                function saveManualData() {
                    const btn = document.querySelector('button');
                    const priceInput = document.getElementById('manualPrice').value;
                    const nameInput = document.getElementById('manualName').value || 'Saved Item';
                    if (!priceInput || priceInput <= 0) return;
                    btn.innerText = "Syncing..."; btn.style.background = "#10b981";
                    fetch('https://wallet-y7yv.onrender.com/api/add-wishlist', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: String(Date.now()), title: nameInput, price: parseFloat(priceInput), link: '${targetUrl}', imageUrl: '', category: 'MANUAL', wishCategory: 'Other', timestamp: Date.now() })
                    }).then(() => { document.getElementById('manualEntryBox').innerHTML = '<h2>Saved!</h2>'; setTimeout(() => window.close(), 1500); });
                }
            </script>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));