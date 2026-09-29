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
  RN 2–5 kg (4–11 lb) · 160u · $50
  S 3–6 kg (6–13 lb) · 160u · $50
  M 4–9 kg (9–20 lb) · 144u · $50
  L 7–18 kg (15–40 lb) · 128u · $45
  XL 12–25 kg (26–55 lb) · 112u · $45
  XXL más de 55 lb · 112u · $45
  Pañales NATEEN PANTS (tipo pantaloncito), solo tallas L a XXL, caja de 160u a $55:
  Pants L 9–14 kg (19–31 lb) · Pants XL 12–17 kg (26–37.5 lb) · Pants XXL más de 15 kg (más de 33 lb)
  También hay paquete de prematuro (menos de 6 lb, 50u, $17) y presentaciones pequeñas para probar la talla antes de la caja grande.
- Wipes Nateen: hipoalergénicos, en caja grande (13 paquetes de 80 = 1.040 toallitas) por $25.
- Wipes de agua Dany Baby (agua 99% pura): caja de 12 paquetes de 50 = 600 toallitas por $25. Ya no hay combo de 2 cajas.
- Wipes Nateen Adulto: pack de 6 paquetes de 40 = 240 toallitas por $15.
- Fulares/portabebés Moon: unitalla ajustable, de recién nacido hasta ~25 lbs. $46.

TALLAS: usa la tabla de pesos para responder "¿qué talla le toca a mi bebé?". Usa siempre "talla" (nunca "size") y libras cuando hables con la mamá.

DIFERENCIALES (úsalos al recomendar): venta en cajas grandes que alcanzan para todo el mes (más accesible que el paquete suelto) · talla XXL para más de 55 lb, difícil de conseguir en Panamá · marcas de buena reputación a precio accesible · atención directa y personalizada por WhatsApp.

ENTREGA Y COMPRA:
- Baby Caleb vende ÚNICAMENTE online: los pedidos entran por WhatsApp o por DM de Instagram y se entregan por delivery a domicilio en Ciudad de Panamá.
- NO hay tienda física ni punto de retiro. Si preguntan por una tienda, explícalo con calidez y ofrece el delivery.
- El costo exacto y la zona de cobertura del delivery NO están confirmados: pregunta la zona y pasa a WhatsApp para cotizar. NUNCA inventes un costo.
- Métodos de pago: no confirmados. No los inventes; los coordina el humano por WhatsApp.

CONTACTO: WhatsApp ${WHATSAPP} (canal de cierre) · Email babycalebpanama@gmail.com · Instagram @babycalebpanama · Facebook Baby Caleb.

PUEDES EDUCAR sobre: "libre de cloro" vs "sin cloro" (no es lo mismo); qué es un pañal hipoalergénico y por qué importa en piel sensible; señales de que tu bebé lo necesita (rozaduras, irritación); beneficios Nateen (bambú, biodegradable, sin perfumes/alcohol/cloro, protección contra fugas).

NUNCA declares un producto como una marca que no es (por ejemplo, jamás llames "WaterWipes" a un wipe que no lo sea). Nunca minimices la seguridad del bebé ni exageres beneficios sin respaldo. Nunca uses mensajería religiosa.

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
