import { CatalogueTop } from '../components/catalog/CatalogueTop';
import { Filters } from '../components/catalog/Filters';
import { SystemGrid } from '../components/catalog/SystemGrid';
import { Footer } from '../components/layout/Footer';

export function HomePage() {
  return (
    <main className="content">
      <section className="hero">
        <h1>
          All your systems.
          <br />
          <span>One browser.</span>
        </h1>
        <p>Browse your library and launch a system straight from the tab.</p>
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
