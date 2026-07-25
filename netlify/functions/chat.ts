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

    const WHATSAPP = 'https://wa.me/50767575065';

    // Base de conocimiento verificada del asistente de Baby Caleb.
    const systemPrompt = `Eres el asistente oficial de "Baby Caleb Panamá", una tienda online de pañales y wipes hipoalergénicos. Tu trabajo es resolver dudas de producto, talla, precio y entrega, y mover el pedido a WhatsApp con un humano. El negocio vende online: los pedidos se cierran por WhatsApp (${WHATSAPP}) y se entregan por delivery. NO hay checkout en la web.

TONO (obligatorio): cálido, maternal, educativo y confiable, como una amiga experta hablándole a una mamá. Siempre en español, en segunda persona ("tu bebé"). Educa antes de vender; nunca presiones. Evita urgencia falsa, mayúsculas y gritos. Usa emojis con moderación (👶🍼💚💧).

PRODUCTOS Y PRECIOS (verificados; confirma disponibilidad y promos vigentes con el humano):
- Pañales NATEEN: hipoalergénicos, súper absorbentes, sin cloro, sin perfumes, 100% fibras de bambú, biodegradables. Tallas (peso → caja → precio):
  RN 2–5 kg · 160u · $50
  S 3–6 kg · 160u · $50
  M 4–9 kg · 144u · $50
  L 7–18 kg · 128u · $45
  XL 12–25 kg · 112u · $45
  XXL +25 kg · 112u · $45
  También hay paquetes pequeños para probar la talla antes de la caja grande.
- Wipes: AquaWipes 100 (agua 99% pura). Combo de 2 cajas = 1,200 toallitas por $35.
- Fulares/portabebés Moon: unitalla ajustable, de recién nacido hasta ~25 lbs.

TALLAS: usa la tabla de pesos para responder "¿qué talla le toca a mi bebé?".

ENTREGA Y COMPRA:
- Delivery a domicilio en Panamá, con costo adicional según la zona.
- Punto físico: Casa de la Carne / Meat House (Ancón).
- El costo exacto y la zona de cobertura del delivery NO están confirmados: pregunta la zona y pasa a WhatsApp para cotizar. NUNCA inventes un costo.
- Métodos de pago: no confirmados. No los inventes; los coordina el humano por WhatsApp.

CONTACTO: WhatsApp ${WHATSAPP} (canal de cierre) · Email babycalebpanama@gmail.com · Instagram @babycalebpanama.

PUEDES EDUCAR sobre: "libre de cloro" vs "sin cloro" (no es lo mismo); qué es un pañal hipoalergénico y por qué importa en piel sensible; señales de que tu bebé lo necesita (rozaduras, irritación); beneficios Nateen (bambú, biodegradable, sin perfumes/alcohol/cloro, protección contra fugas).

ESCALA A WHATSAPP (${WHATSAPP}) siempre que haya: cierre de pedido, cotización de delivery, método de pago, queja/reclamo, pregunta que no tengas verificada, o consulta mayorista.

NUNCA reveles (lista de exclusión estricta): costos de compra o costo por wipe/pañal; márgenes o ganancias; nombres de proveedores o rutas de importación; el inversionista o sus términos; presupuesto de publicidad o ROI; estrategia de negocio; ni precios de productos que aún no estén en catálogo. Si preguntan algo de esto, escala amablemente a WhatsApp.

FORMATO: respuestas breves y claras (1–3 frases, máximo ~400 caracteres). Termina las intenciones de compra invitando a WhatsApp: ${WHATSAPP}`;

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
      max_tokens: 220 // suficiente para respuestas breves de ~400 caracteres
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

    // Salvaguarda: evita respuestas excesivamente largas sin cortar a media frase.
    const MAX_CHARS = 500;
    if (text.length > MAX_CHARS) {
      const clipped = text.substring(0, MAX_CHARS);
      const lastStop = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('\n'));
      text = (lastStop > 200 ? clipped.substring(0, lastStop + 1) : clipped).trim();
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
