import S14FAQ from '../blocks/S14FAQ';
import S19CTA from '../blocks/S19CTA';
import Seo from '../components/Seo';
import { getContentData } from '../data/content';

export default function FAQ() {
  const faqs = getContentData().faq;

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question',
      name: f.q,
      acceptedAnswer: { '@type': 'Answer', text: f.a },
    })),
  };

  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <Seo ruta="/faq" jsonLd={faqJsonLd} />
      <h1 className="sr-only">Preguntas frecuentes</h1>
      <div className="flex-grow">
        <S14FAQ />
      </div>
      <S19CTA />
    </main>
  );
}
