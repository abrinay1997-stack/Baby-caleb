import S12Historia from '../blocks/S12Historia';
import S04Trust from '../blocks/S04Trust';
import S03Education from '../blocks/S03Education';
import S19CTA from '../blocks/S19CTA';

export default function Historia() {
  return (
    <main className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <div className="flex-grow">
        <S12Historia />
        <S04Trust />
        <S03Education />
      </div>
      <S19CTA />
    </main>
  );
}
