import { CatalogueTop } from '../components/catalog/CatalogueTop';
import { Filters } from '../components/catalog/Filters';
import { SystemGrid } from '../components/catalog/SystemGrid';
import { Footer } from '../components/layout/Footer';

export function HomePage() {
  return (
    <main className="content">
      <section className="hero">
        <h1>
          Tous vos systèmes.
          <br />
          <span>Un seul navigateur.</span>
        </h1>
        <p>Explorez votre bibliothèque et lancez un système directement depuis l&apos;onglet.</p>
      </section>

      <section className="catalogue" id="catalogue" aria-labelledby="catalogue-heading">
        <CatalogueTop />
        <Filters />
        <SystemGrid />
      </section>

      <Footer />
    </main>
  );
}
