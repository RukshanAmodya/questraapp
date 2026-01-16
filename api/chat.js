import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const getGroqKeys = () => {
    return Object.keys(process.env)
        .filter(key => key.startsWith('GROQ_KEY_'))
        .map(key => process.env[key]);
};

export default async function handler(req, res) {
    // 1. OPTIONS Request එකට අවසර දීම (Preflight)
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { client_id, session_id, message } = req.body;

    try {
        if (!client_id || !message) throw new Error("Missing client_id or message");

        // 2. Client Check
        const { data: client, error: clientErr } = await supabase
            .from('clients')
            .select('*')
            .eq('id', client_id)
            .single();

        if (clientErr || !client || client.status !== 'active') {
            return res.json({ reply: "සේවාව තාවකාලිකව අත්හිටුවා ඇත." });
        }

        // 3. Key Rotation & Model Selection
        const keys = getGroqKeys();
        const currentKey = keys[Math.floor(Math.random() * keys.length)];
        const model = client.package_type === "Pro AI" ? "llama-3.3-70b-versatile" : "llama-3.1-8b-instant";

        // 4. History (Context)
        const { data: history } = await supabase
            .from('conversations')
            .select('role, content')
            .eq('session_id', session_id)
            .order('created_at', { ascending: false })
            .limit(4);

        const formattedHistory = history ? history.reverse().map(h => ({ role: h.role, content: h.content })) : [];

        // 5. Groq API Call
        const aiResponse = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model: model,
            messages: [
                { role: "system", content: `You are Ria, the AI assistant for ${client.name}. Respond politely.` },
                ...formattedHistory,
                { role: "user", content: message }
            ],
            temperature: 0.6
        }, {
            headers: { 'Authorization': `Bearer ${currentKey}` },
            timeout: 10000
        });

        const botReply = aiResponse.data.choices[0].message.content;

        // 6. DB Update (Background)
        Promise.all([
            supabase.from('conversations').insert([
                { client_id, session_id, role: 'user', content: message },
                { client_id, session_id, role: 'assistant', content: botReply }
            ]),
            supabase.rpc('increment_usage', { cid: client_id })
        ]).catch(e => console.error("DB Update Error:", e));

        return res.status(200).json({ reply: botReply });

    } catch (error) {
        console.error("ERROR:", error.message);
        // Error එකකදීත් 200 දී JSON එකක් යැවීමෙන් CORS Error එක මඟහරවා ගත හැක
        return res.status(200).json({ 
            reply: "සමාවන්න, පද්ධතියේ දෝෂයක් පවතී. කරුණාකර නැවත උත්සාහ කරන්න.",
            debug: error.message 
        });
    }
}
