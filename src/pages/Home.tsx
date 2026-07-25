import S02Hero from '../blocks/S02Hero';
import S04Trust from '../blocks/S04Trust';
import S03Education from '../blocks/S03Education';
import S11Testimonials from '../blocks/S11Testimonials';
import S19CTA from '../blocks/S19CTA';
import S18Coverage from '../blocks/S18Coverage';
import Seo from '../components/Seo';

export default function Home() {
  return (
    <main id="main-content">
      <Seo
        title="Baby Caleb Panamá | Pañales y Wipes Nateen hipoalergénicos"
        description="Pañales Nateen hipoalergénicos de bambú, sin cloro, sin perfumes. Talla Prematuro a XL. Delivery en Ciudad de Panamá y retiro en Casa de la Carne (Ancón)."
        path="/"
      />
      <S02Hero />
      <S04Trust />
      <S03Education />
      <S11Testimonials />
      <S18Coverage />
      <S19CTA />
    </main>
  );
}
