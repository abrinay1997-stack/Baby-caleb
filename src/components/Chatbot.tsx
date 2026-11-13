import React, { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Heart, MessageSquare } from 'lucide-react';
import { sesionDelChat } from '../chat/sesion';
import { WHATSAPP_URL } from '../data/contacto';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * El chat de la tienda.
 *
 * ## Lo que se midió el 2026-11-13, con teclado y con lector de pantalla
 *
 *  · Al abrirlo, el foco se perdía: el botón que lo abre se desmonta, y con él
 *    se iba el foco al `<body>`. Quien navega con teclado tenía que volver a
 *    tabular el sitio entero para llegar a un cuadro que ya estaba abierto.
 *  · **Una respuesta nueva no se anunciaba NUNCA.** No había una sola región
 *    `aria-live` en la página. Para quien no ve la pantalla, preguntar y que
 *    contesten era indistinguible de preguntar y que no conteste nadie. Es
 *    WCAG 4.1.3 (*Status Messages*), AA.
 *  · Escape no cerraba.
 *  · El aspa de cerrar medía 20×20 px. WCAG 2.2 pide 24×24 como mínimo
 *    (2.5.8), y sin Escape tampoco había otra forma de cerrar.
 *  · El campo de escribir tenía 12 px: con menos de 16, iOS hace zoom al
 *    enfocar y la pantalla se descoloca sola justo cuando alguien escribe.
 *
 * Todo eso está resuelto abajo. Lo que NO se tocó es el aspecto: mismos
 * colores, mismo sitio, mismo tamaño de la ventana.
 */
export default function Chatbot() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: '¡Hola! 👶 Bienvenido a Baby Caleb. ¿En qué puedo ayudarte hoy?',
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const campoRef = useRef<HTMLInputElement>(null);
  const globoRef = useRef<HTMLButtonElement>(null);
  /** Para no robar el foco en la primera pintada, solo al abrir y al cerrar. */
  const seAbrioAlguna = useRef(false);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [isOpen, messages]);

  // El foco entra al abrir y vuelve al globo al cerrar. Al abrir va al campo
  // de escribir, que es a lo que se vino: con el teclado del teléfono, además,
  // es lo que hace que salga el teclado sin un toque de más.
  useEffect(() => {
    if (isOpen) {
      seAbrioAlguna.current = true;
      campoRef.current?.focus();
      return;
    }
    if (seAbrioAlguna.current) globoRef.current?.focus();
  }, [isOpen]);

  // Escape cierra, como en cualquier cuadro que se abre encima.
  useEffect(() => {
    if (!isOpen) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setIsOpen(false);
      }
    };
    document.addEventListener('keydown', alTeclear);
    return () => document.removeEventListener('keydown', alTeclear);
  }, [isOpen]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    const newMessages = [...messages, { role: 'user', content: userMessage } as Message];
    setMessages(newMessages);
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // Send messages history except for the initial greeting to keep the prompt clean and lightweight
          messages: newMessages.slice(1),
          // La sesión agrupa los mensajes en UNA conversación del CRM (F3.6),
          // en vez de abrir una nueva con cada pregunta. El historial se sigue
          // mandando porque el camino viejo (Groq) todavía lo necesita; cuando
          // se apague, el CRM lleva su propia memoria y esto sobra.
          sesion: sesionDelChat(),
        }),
      });

      if (!response.ok) {
        throw new Error('No se pudo enviar el mensaje.');
      }

      // `response.json()` devuelve `unknown`: sin esta anotación `data.reply`
      // no compila. Solo es el tipo; el comportamiento no cambia.
      const data = (await response.json()) as { reply?: string };
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: data.reply || 'Lo siento, hubo un problema al responder.' },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: 'Lo siento, cariño, mi sistema tuvo un pequeño error. ¿Me repites la duda?' },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed bottom-6 right-6 z-50 font-body">
      {/* Chat Button */}
      {!isOpen && (
        <button
          ref={globoRef}
          onClick={() => setIsOpen(true)}
          className="flex items-center justify-center w-14 h-14 rounded-full bg-accent text-accent-fg shadow-xl hover:scale-105 transition-transform duration-200 cursor-pointer focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-4"
          aria-label="Abrir el chat de Baby Caleb"
        >
          <MessageCircle size={28} aria-hidden="true" />
        </button>
      )}

      {/* Chat Window */}
      {isOpen && (
        <div
          role="dialog"
          // `aria-modal="false"`: no bloquea la página y no quiere decir que
          // lo haga. Se puede seguir leyendo la tienda con el chat abierto, y
          // mentir aquí le diría al lector de pantalla que el resto no existe.
          aria-modal="false"
          aria-label="Chat con el asistente de Baby Caleb"
          // `100dvw` y no `100vw`: en el teléfono `vw` no descuenta la barra
          // del navegador y la ventana se asoma por el borde.
          className="flex flex-col w-[350px] h-[480px] max-h-[70dvh] max-w-[calc(100dvw-2rem)] bg-surface rounded-2xl shadow-2xl border border-line overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-accent text-accent-fg">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-bg flex items-center justify-center text-accent-strong">
                <Heart size={16} fill="currentColor" />
              </div>
              <div>
                <h3 className="font-display font-bold text-sm leading-tight">Asistente Baby Caleb</h3>
                {/* Sin el `/80`: el navy al 80 % sobre el naranja da 4.02 y AA pide
                    4.5 a 12 px. El par entero —navy sobre naranja, 5.56— es el que
                    `brand.json` tiene medido, y es el mismo de los botones. */}
                <span className="text-xs text-accent-fg">En línea • IA</span>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              // Medía 20×20 y WCAG 2.2 pide 24×24 (2.5.8). `-mr-2` para que
              // la caja crezca hacia dentro y el aspa no se mueva de sitio.
              className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-accent-fg/80 transition-colors hover:text-accent-fg focus-visible:outline-accent-fg focus-visible:outline-2 focus-visible:outline-offset-2"
              aria-label="Cerrar el chat"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </div>

          {/* Messages Area */}
          {/* `role="log"` con `aria-live="polite"`: cada burbuja nueva se lee
              sola, y «polite» espera a que la persona termine de escribir en
              vez de interrumpirla. Sin esto —que es como estaba— preguntar y
              que contesten sonaba igual que preguntar y que no conteste nadie.
              `aria-relevant="additions"` para que no relea el hilo entero cada
              vez que llega un mensaje. */}
          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-label="Conversación"
            className="flex-1 overflow-y-auto p-4 space-y-3 bg-bg"
          >
            {messages.map((msg, index) => {
              const isUser = msg.role === 'user';
              return (
                <div key={index} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  {/* Quién habla, en texto. En la pantalla lo dice el lado y
                      el color de la burbuja, y eso es exactamente lo que un
                      lector de pantalla no transmite: sin esto, las dos voces
                      se oyen como un solo monólogo. */}
                  <span className="sr-only">{isUser ? 'Tú:' : 'Asistente:'}</span>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-normal shadow-sm ${
                      isUser
                        ? 'bg-accent text-accent-fg rounded-tr-none'
                        : 'bg-surface text-fg rounded-tl-none border border-line'
                    }`}
                  >
                    {msg.content}
                  </div>
                </div>
              );
            })}
            {isLoading && (
              <div className="flex justify-start">
                <div className="bg-surface text-muted rounded-2xl rounded-tl-none px-3 py-2 text-sm border border-line shadow-sm flex items-center gap-1">
                  <span aria-hidden="true" className="animate-bounce">👶</span>
                  <span>Escribiendo…</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Actions / WhatsApp Direct */}
          <div className="px-4 bg-surface border-t border-b border-line flex justify-between items-center gap-2 text-xs">
            <span className="text-muted">¿Prefieres WhatsApp?</span>
            {/* El número sale de `data/contacto.ts`, que es su único dueño.
                Aquí estaba escrito a mano —el séptimo sitio, justo el que ese
                archivo existe para evitar— y el día que cambie, este se queda
                mandando a un celular que ya no contesta sin que nada falle. */}
            <a
              href={WHATSAPP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-11 items-center gap-1 font-bold text-accent-strong hover:underline focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2 rounded-md"
            >
              <MessageSquare size={14} aria-hidden="true" />
              Hablar por WhatsApp
            </a>
          </div>

          {/* Message Input Form */}
          <form onSubmit={handleSendMessage} className="p-3 bg-surface flex items-end gap-2">
            {/* El campo no llevaba etiqueta: un lector de pantalla lo anunciaba
                como «cuadro de edición» y nada más. El `placeholder` no cuenta
                —desaparece en cuanto se escribe la primera letra—. */}
            <label htmlFor="chat-mensaje" className="sr-only">
              Escribe tu mensaje para el asistente
            </label>
            <input
              ref={campoRef}
              id="chat-mensaje"
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Escribe tu mensaje…"
              maxLength={250}
              autoComplete="off"
              // `text-base` = 16 px. Con menos, iOS hace zoom al enfocar y la
              // pantalla se descoloca sola justo al empezar a escribir. Tenía
              // 12. Y el aro de foco vuelve: estaba apagado con
              // `focus:outline-none` y lo único que quedaba era un borde de un
              // píxel cambiando de color.
              className="min-h-11 flex-1 rounded-xl border border-line bg-bg px-3 text-base text-fg focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              aria-label="Enviar el mensaje"
              // Medía 32×32. 44 es lo que acierta un pulgar con un bebé en el
              // otro brazo, que es como se usa esta pantalla.
              className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent text-accent-fg transition-opacity focus-visible:outline-accent-edge focus-visible:outline-2 focus-visible:outline-offset-2 ${
                isLoading || !input.trim() ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90 cursor-pointer'
              }`}
            >
              <Send size={18} aria-hidden="true" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
