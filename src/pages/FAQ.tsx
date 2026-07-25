import S14FAQ from '../blocks/S14FAQ';
import S19CTA from '../blocks/S19CTA';

export default function FAQ() {
  return (
    <main className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <div className="flex-grow">
        <S14FAQ />
      </div>
      <S19CTA />
    </main>
  );
}
