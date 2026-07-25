import S09Products from '../blocks/S09Products';
import S19CTA from '../blocks/S19CTA';

export default function Productos() {
  return (
    <main className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <div className="flex-grow">
        <S09Products />
      </div>
      <S19CTA />
    </main>
  );
}
