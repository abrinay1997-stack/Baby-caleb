import S16HowToBuy from '../blocks/S16HowToBuy';
import S18Coverage from '../blocks/S18Coverage';
import S19CTA from '../blocks/S19CTA';

export default function ComoComprar() {
  return (
    <main className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <div className="flex-grow">
        <S16HowToBuy />
        <S18Coverage />
      </div>
      <S19CTA />
    </main>
  );
}
