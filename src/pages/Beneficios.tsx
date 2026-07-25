import S08Differentiators from '../blocks/S08Differentiators';
import S11Testimonials from '../blocks/S11Testimonials';
import S19CTA from '../blocks/S19CTA';

export default function Beneficios() {
  return (
    <main className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <div className="flex-grow">
        <S08Differentiators />
        <S11Testimonials />
      </div>
      <S19CTA />
    </main>
  );
}
