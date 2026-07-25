import S13Tips from '../blocks/S13Tips';
import S03Education from '../blocks/S03Education';
import S19CTA from '../blocks/S19CTA';
import Seo from '../components/Seo';

export default function Tips() {
  return (
    <main id="main-content" className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <Seo
        title="Tips y cuidado de la piel del bebé | Baby Caleb Panamá"
        description="Consejos prácticos para evitar la pañalitis, entender el cloro TCF y reconocer señales de irritación en la piel de tu bebé."
        path="/tips"
      />
      <h1 className="sr-only">Tips para cuidar la piel de tu bebé</h1>
      <div className="flex-grow">
        <S13Tips />
        <S03Education />
      </div>
      <S19CTA />
    </main>
  );
}
