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
  /**
   * El código de la variante en el catálogo del sistema (F3.5).
   *
   * El PRECIO ya no vive aquí: vive en la D1 del sistema y la web lo pide a
   * `/api/catalogo`. Lo que queda en este archivo es a qué fila del catálogo
   * corresponde esta tarjeta. Sin código, la web dice «Consultar» en vez de
   * inventar un número.
   */
  codigo?: string;
  image: string;
}

export interface ProductData {
  id: string;
  name: string;
  description: string;
  image: string;
  /**
   * Fuera de circulación según el documento de la dueña.
   *
   * No se borra del archivo —el contenido es suyo— pero no se pinta: vender lo
   * que no existe acaba en un pedido que nadie puede cumplir, y en un bot que
   * le dice a la clienta lo contrario que la web.
   */
  descatalogado?: boolean;
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
