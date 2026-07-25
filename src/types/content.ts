export interface MetaData {
  title: string;
  description: string;
  ogImage: string;
}

export interface CTAData {
  label: string;
  href: string;
}

export interface HeroData {
  kicker: string;
  h1: string;
  sub: string;
  cta: CTAData;
}

export interface TrustItem {
  icon: string;
  label: string;
}

export interface ProductData {
  id: string;
  name: string;
  description: string;
  sizes: string[];
  options: string[];
  image: string;
}

export interface DifferentiatorData {
  title: string;
  text: string;
}

export interface EducationData {
  question: string;
  answer: string;
}

export interface TestimonialData {
  name: string;
  role: string;
  quote: string;
  result: string;
  date: string;
}

export interface HowToBuyStep {
  step: string;
  title: string;
  text: string;
}

export interface FAQItem {
  q: string;
  a: string;
}

export interface NAPData {
  address: string;
  phone: string;
  hours: string[];
  maps: string;
}

export interface LegalData {
  company: string;
  vat: string;
  privacyUrl: string;
}

export interface SocialData {
  instagram: string;
  facebook: string;
  whatsapp: string;
  email: string;
}

export interface ContentData {
  meta: MetaData;
  hero: HeroData;
  trust: TrustItem[];
  products: ProductData[];
  differentiators: DifferentiatorData[];
  education: EducationData[];
  testimonials: TestimonialData[];
  howToBuy: HowToBuyStep[];
  faq: FAQItem[];
  nap: NAPData;
  legal: LegalData;
  social: SocialData;
}
