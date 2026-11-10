import S08Differentiators from '../blocks/S08Differentiators';
import S11Testimonials from '../blocks/S11Testimonials';
import S19CTA from '../blocks/S19CTA';
import Seo from '../components/Seo';

export default function Beneficios() {
  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <Seo ruta="/beneficios" />
      <h1 className="sr-only">Beneficios de los pañales hipoalergénicos Nateen</h1>
      <div className="flex-grow">
        <S08Differentiators />
        <S11Testimonials />
      </div>
      <S19CTA />
    </main>
  );
}
