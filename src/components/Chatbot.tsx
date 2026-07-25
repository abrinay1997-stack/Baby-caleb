import React, { useState, useRef, useEffect } from 'react';
import { MessageCircle, X, Send, Heart, MessageSquare } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isOpen) {
      scrollToBottom();
    }
  }, [isOpen, messages]);

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
        }),
      });

      if (!response.ok) {
        throw new Error('No se pudo enviar el mensaje.');
      }

      const data = await response.json();
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
          onClick={() => setIsOpen(true)}
          className="flex items-center justify-center w-14 h-14 rounded-full bg-accent text-accent-fg shadow-xl hover:scale-105 transition-transform duration-200 cursor-pointer"
          aria-label="Abrir Chat"
        >
          <MessageCircle size={28} />
        </button>
      )}

      {/* Chat Window */}
      {isOpen && (
        <div className="flex flex-col w-[350px] h-[480px] max-w-[calc(100vw-2rem)] bg-surface rounded-2xl shadow-2xl border border-line overflow-hidden animate-in fade-in slide-in-from-bottom-5 duration-300">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-accent text-accent-fg">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-bg flex items-center justify-center text-accent">
                <Heart size={16} fill="currentColor" />
              </div>
              <div>
                <h3 className="font-display font-bold text-sm leading-tight">Asistente Baby Caleb</h3>
                <span className="text-[10px] text-accent-fg/80">En línea • IA</span>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="text-accent-fg/80 hover:text-accent-fg transition-colors"
              aria-label="Cerrar Chat"
            >
              <X size={20} />
            </button>
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-bg">
            {messages.map((msg, index) => {
              const isUser = msg.role === 'user';
              return (
                <div key={index} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-normal shadow-sm ${
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
                <div className="bg-surface text-muted rounded-2xl rounded-tl-none px-3 py-2 text-xs border border-line shadow-sm flex items-center gap-1">
                  <span className="animate-bounce">👶</span>
                  <span>Escribiendo...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Quick Actions / WhatsApp Direct */}
          <div className="px-4 py-1.5 bg-surface border-t border-b border-line flex justify-between items-center text-[11px]">
            <span className="text-muted">¿Prefieres WhatsApp?</span>
            <a
              href="https://wa.me/50767575065"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 font-bold text-accent hover:underline"
            >
              <MessageSquare size={12} />
              Hablar por WhatsApp
            </a>
          </div>

          {/* Message Input Form */}
          <form onSubmit={handleSendMessage} className="p-3 bg-surface flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Escribe tu mensaje..."
              maxLength={200}
              className="flex-1 bg-bg border border-line rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-accent text-fg"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className={`flex items-center justify-center w-8 h-8 rounded-xl bg-accent text-accent-fg transition-opacity ${
                isLoading || !input.trim() ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90 cursor-pointer'
              }`}
            >
              <Send size={14} />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
