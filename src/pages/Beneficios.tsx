import S08Differentiators from '../blocks/S08Differentiators';
import S11Testimonials from '../blocks/S11Testimonials';
import S19CTA from '../blocks/S19CTA';
import Seo from '../components/Seo';

export default function Beneficios() {
  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <Seo
        title="Beneficios | Pañales hipoalergénicos Nateen — Baby Caleb Panamá"
        description="Cajas para todo el mes, tallas de RN a XXL, atención personal por WhatsApp y delivery a domicilio. Descubre por qué las familias eligen Baby Caleb."
        path="/beneficios"
      />
      <h1 className="sr-only">Beneficios de los pañales hipoalergénicos Nateen</h1>
      <div className="flex-grow">
        <S08Differentiators />
        <S11Testimonials />
      </div>
      <S19CTA />
    </main>
  );
}
