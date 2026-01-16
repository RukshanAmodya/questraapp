import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

// --- Supabase Config ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Environment variables වලින් GROQ_KEY_1, 2, 3 ලබා ගැනීම
const getGroqKeys = () => {
    return Object.keys(process.env)
        .filter(key => key.startsWith('GROQ_KEY_'))
        .map(key => process.env[key]);
};

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export default async function handler(req, res) {
    // --- 1. CORS Headers (Security & Access) ---
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); // සියලුම Domains වලට ඉඩ දෙයි
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // Browser එකෙන් එවන 'OPTIONS' (Preflight) request එක handle කිරීම
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { client_id, session_id, message } = req.body;

    // input validation
    if (!client_id || !message) {
        return res.status(400).json({ error: "Missing required fields: client_id or message" });
    }

    try {
        // 2. පාරිභෝගිකයාගේ අවසරය සහ ලිමිට් පරීක්ෂා කිරීම
        const { data: client, error: clientErr } = await supabase
            .from('clients')
            .select('*')
            .eq('id', client_id)
            .single();

        if (clientErr || !client || client.status !== 'active') {
            return res.json({ reply: "ඔබේ සේවාව තාවකාලිකව අත්හිටුවා ඇත. කරුණාකර ගෙවීම් සම්පූර්ණ කරන්න." });
        }

        // 3. අද දින භාවිතය පරීක්ෂා කිරීම
        const today = new Date().toISOString().split('T')[0];
        const { data: usage } = await supabase
            .from('usage_logs')
            .select('count')
            .eq('client_id', client_id)
            .eq('usage_date', today)
            .single();

        if (usage && usage.count >= client.daily_limit) {
            return res.json({ reply: "ඔබේ දෛනික පණිවිඩ සීමාව අවසන් වී ඇත. හෙට නැවත උත්සාහ කරන්න." });
        }

        // 4. Context ලබා ගැනීම (Last 6 messages)
        const { data: history } = await supabase
            .from('conversations')
            .select('role, content')
            .eq('session_id', session_id)
            .order('created_at', { ascending: false })
            .limit(6);

        const formattedHistory = history ? history.reverse().map(h => ({ role: h.role, content: h.content })) : [];

        // 5. Key Rotation Logic
        const keys = getGroqKeys();
        if (keys.length === 0) throw new Error("No Groq Keys configured in Environment Variables.");
        const currentKey = keys[Math.floor(Math.random() * keys.length)];

        // 6. AI Model එක තේරීම
        const model = client.package_type === "Pro AI" ? "openai/gpt-oss-120b" : "llama-3.3-70b-versatile";

        // 7. Groq AI Call එක
        const aiResponse = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: model,
            messages: [
                { role: "system", content: `You are an AI assistant Ria for ${client.name}. Help customers politely in Sinhala or English.` },
                ...formattedHistory,
                { role: "user", content: message }
            ],
            temperature: 0.7
        }, {
            headers: { 
                'Authorization': `Bearer ${currentKey}`,
                'Content-Type': 'application/json' 
            },
            timeout: 15000 // 15 seconds timeout
        });

        const botReply = aiResponse.data.choices[0].message.content;

        // 8. Database එකේ දත්ත සුරැකීම (Async)
        await Promise.all([
            supabase.from('conversations').insert([
                { client_id, session_id, role: 'user', content: message },
                { client_id, session_id, role: 'assistant', content: botReply }
            ]),
            supabase.rpc('increment_usage', { cid: client_id })
        ]);

        // 9. Telegram Alert (Keywords තිබේ නම් පමණක්)
        const orderKeywords = ["order", "ගන්න", "මිල", "කීයද", "ඇණවුම", "price"];
        if (orderKeywords.some(kw => message.toLowerCase().includes(kw) || botReply.toLowerCase().includes(kw))) {
             axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                chat_id: client.telegram_chat_id,
                text: `🔔 *New Lead Identified!*\n\n*Business:* ${client.name}\n*User:* ${message}\n*AI:* ${botReply}`,
                parse_mode: 'Markdown'
            }).catch(e => console.error("Telegram Error:", e.message));
        }

        return res.status(200).json({ reply: botReply });

    } catch (error) {
        console.error("CRITICAL BACKEND ERROR:", error.response?.data || error.message);
        
        // Error එක JSON එකක් විදිහටම යැවීම (CORS Error එක වැළැක්වීමට)
        return res.status(500).json({ 
            error: "AI Engine error", 
            message: "සමාවන්න, පද්ධතියේ දෝෂයක් පවතී. කරුණාකර නැවත උත්සාහ කරන්න." 
        });
    }
}
