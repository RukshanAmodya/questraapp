import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

// --- CONFIGURATION (Environment Variables වලින් දත්ත ලබා ගැනීම) ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// API Keys පද්ධතිය - දහයක වුවද Keys එකතු කළ හැක
const getGroqKeys = () => {
    return Object.keys(process.env)
        .filter(key => key.startsWith('GROQ_KEY_'))
        .map(key => process.env[key]);
};

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export default async function handler(req, res) {
    // CORS සහ Method පාලනය
    if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

    const { client_id, session_id, message } = req.body;

    try {
        // 1. පාරිභෝගිකයාගේ අවසරය සහ ලිමිට් පරීක්ෂා කිරීම
        const { data: client, error: clientErr } = await supabase
            .from('clients')
            .select('*')
            .eq('id', client_id)
            .single();

        if (clientErr || client.status !== 'active') {
            return res.json({ reply: "ඔබේ සේවාව තාවකාලිකව අත්හිටුවා ඇත. කරුණාකර ගෙවීම් සම්පූර්ණ කරන්න." });
        }

        // 2. අද දින භාවිතය පරීක්ෂා කිරීම
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

        // 3. කලින් කතා කරපු දේ ලබා ගැනීම (Context - Last 6 messages)
        const { data: history } = await supabase
            .from('conversations')
            .select('role, content')
            .eq('session_id', session_id)
            .order('created_at', { ascending: false })
            .limit(6);

        const formattedHistory = history ? history.reverse().map(h => ({ role: h.role, content: h.content })) : [];

        // 4. Key Rotation Logic (Keys Array එකෙන් එකක් තෝරා ගැනීම)
        const keys = getGroqKeys();
        const currentKey = keys[Math.floor(Math.random() * keys.length)];

        // 5. AI Model එක තේරීම (Package එක අනුව)
        const model = client.package_type === "Pro AI" ? "openai/gpt-oss-120b" : "llama-3.3-70b-versatile";

        // 6. Groq AI වෙත පණිවිඩය යැවීම
        const aiResponse = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: model,
            messages: [
                { role: "system", content: `You are a creative partner Ria for ${client.name}. Help clients professionally.` },
                ...formattedHistory,
                { role: "user", content: message }
            ],
            temperature: 0.7
        }, {
            headers: { 'Authorization': `Bearer ${currentKey}`, 'Content-Type': 'application/json' }
        });

        const botReply = aiResponse.data.choices[0].message.content;

        // 7. පණිවිඩ ඉතිහාසය සුරැකීම
        await supabase.from('conversations').insert([
            { client_id, session_id, role: 'user', content: message },
            { client_id, session_id, role: 'assistant', content: botReply }
        ]);

        // 8. භාවිතය (Usage) වැඩි කිරීම (RPC call)
        await supabase.rpc('increment_usage', { cid: client_id });

        // 9. ඇණවුමක් නම් Telegram Notification යැවීම
        const orderKeywords = ["ORDER_CONFIRMED", "ඇණවුම", "ගාණ කීයද", "මිල"];
        if (orderKeywords.some(keyword => botReply.includes(keyword))) {
            await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
                chat_id: client.telegram_chat_id, // Client ගේ පෞද්ගලික ID එක
                text: `🔔 *New Lead/Order!*\n\nBusiness: ${client.name}\nMessage: ${message}\n\nAI Reply: ${botReply}`,
                parse_mode: 'Markdown'
            });
        }

        return res.status(200).json({ reply: botReply });

    } catch (error) {
        console.error("Critical Error:", error.response?.data || error.message);
        return res.status(500).json({ error: "AI Engine එකේ දෝෂයකි. කරුණාකර නැවත උත්සාහ කරන්න." });
    }
}
