export interface MetaData {
  title: string;
  description: string;
  ogImage: string;
}

export interface BrandData {
  name: string;
  tagline: string;
  logo: string;
  badge: string;
}

export interface CTAData {
  label: string;
  href: string;
}

export interface HeroData {
  kicker: string;
  h1: string;
  sub: string;
  image: string;
  cta: CTAData;
}

export interface TrustItem {
  icon: string;
  label: string;
}

export interface ProductVariant {
  size: string;
  range: string;
  units: string;
  /** Precio en USD. Ausente cuando se cotiza por WhatsApp (ej. Fulares Moon). */
  price?: number;
  image: string;
}

export interface ProductData {
  id: string;
  name: string;
  description: string;
  image: string;
  /** Precio "desde". Ausente cuando el producto se cotiza por WhatsApp. */
  priceFrom?: number;
  variants: ProductVariant[];
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

export interface CoverageDelivery {
  zona: string;
  costo: string;
}

export interface CoverageData {
  delivery: CoverageDelivery[];
}

export interface AboutData {
  kicker: string;
  title: string;
  body: string;
  image: string;
}

export interface TipData {
  id: string;
  title: string;
  excerpt: string;
  image: string;
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
  brand: BrandData;
  hero: HeroData;
  trust: TrustItem[];
  products: ProductData[];
  differentiators: DifferentiatorData[];
  education: EducationData[];
  testimonials: TestimonialData[];
  howToBuy: HowToBuyStep[];
  faq: FAQItem[];
  coverage: CoverageData;
  about: AboutData;
  tips: TipData[];
  nap: NAPData;
  legal: LegalData;
  social: SocialData;
}
