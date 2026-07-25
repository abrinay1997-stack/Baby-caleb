import S09Products from '../blocks/S09Products';
import S10Gallery from '../blocks/S10Gallery';
import S18Coverage from '../blocks/S18Coverage';
import S19CTA from '../blocks/S19CTA';

export default function Productos() {
  return (
    <main className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <div className="flex-grow">
        <S09Products />
        <S10Gallery />
        <S18Coverage />
      </div>
      <S19CTA />
    </main>
  );
}
