import { Handler } from '@netlify/functions';

export const handler: Handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'GROQ_API_KEY not configured on server' })
    };
  }

  try {
    const { messages } = JSON.parse(event.body || '{}');
    if (!messages || !Array.isArray(messages)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid or missing messages array' })
      };
    }

    // Define the system instructions for the Llama model
    const systemPrompt = `Eres el chatbot oficial de "Baby Caleb Panamá" (https://wa.me/50767575065).
Tu personalidad es extremadamente dulce, empática, amable y profesional. Respondes con cariño (ej: "¡Hola! 👶", "claro que sí, mami/papi", etc.).
Ofrecemos:
- Pañales ecológicos e hipoalergénicos Nateen (tallas RN, S, M, L, XL, XXL +55 lbs, súper absorbentes, sin cloro TCF, sin químicos).
- Wipes Nateen (99% agua, hipoalergénicas, 80 uds).
- Fulares Moon (portabebés ergonómicos y ajustables).
- Punto físico para retiros: Casa de la Carne / Meat House en Ancón, Panamá, o con delivery.
- WhatsApp de contacto: +507 6757-5065 (https://wa.me/50767575065).

REGLAS DE RESPUESTA ULTRA IMPORTANTES:
1. Responde SIEMPRE en español.
2. TUS RESPUESTAS DEBEN SER EXTRAORDINARIAMENTE CORTAS Y DIRECTAS, CON UN MÁXIMO ABSOLUTO DE 150 CARACTERES (incluyendo espacios y puntuación). No puedes pasarte de 150 caracteres bajo ninguna circunstancia.
3. Si el usuario te pregunta sobre precios, pedidos o cómo comprar, invítalo amablemente a escribir por WhatsApp o usar el enlace directo.
4. Mantén un tono tierno y centrado en el bienestar del bebé.`;

    // Construct the payload for the Groq API
    const groqPayload = {
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m: any) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content
        }))
      ],
      temperature: 0.7,
      max_tokens: 100 // keep it small to respect 150-char limit
    };

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(groqPayload)
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        statusCode: response.status,
        body: JSON.stringify({ error: `Groq API Error: ${errText}` })
      };
    }

    const data = await response.json();
    let text = data.choices?.[0]?.message?.content || '';

    // Enforce 150 characters limit programmatically just in case
    if (text.length > 150) {
      text = text.substring(0, 147) + '...';
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ reply: text })
    };

  } catch (error: any) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message || 'Internal Server Error' })
    };
  }
};
