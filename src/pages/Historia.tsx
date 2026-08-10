import S12Historia from '../blocks/S12Historia';
import S04Trust from '../blocks/S04Trust';
import S03Education from '../blocks/S03Education';
import S19CTA from '../blocks/S19CTA';
import Seo from '../components/Seo';

export default function Historia() {
  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <Seo
        title="Nuestra historia | Baby Caleb Panamá"
        description="Baby Caleb nació en 2024 en Panamá para que conseguir pañales y wipes hipoalergénicos deje de ser una odisea. Marcas de confianza, cajas para todo el mes y delivery."
        path="/historia"
      />
      <h1 className="sr-only">Nuestra historia</h1>
      <div className="flex-grow">
        <S12Historia />
        <S04Trust />
        <S03Education />
      </div>
      <S19CTA />
    </main>
  );
}
