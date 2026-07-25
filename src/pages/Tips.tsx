import S13Tips from '../blocks/S13Tips';
import S03Education from '../blocks/S03Education';
import S19CTA from '../blocks/S19CTA';

export default function Tips() {
  return (
    <main className="pt-32 md:pt-24 min-h-screen flex flex-col">
      <div className="flex-grow">
        <S13Tips />
        <S03Education />
      </div>
      <S19CTA />
    </main>
  );
}
