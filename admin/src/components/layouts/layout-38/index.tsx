import { Helmet } from 'react-helmet-async';
import { Wrapper } from './components/wrapper';
import { LayoutProvider } from './components/context';

export function Layout38() {
  return (
    <>
      <Helmet>
        <title>Layout 38</title>
      </Helmet>

      <LayoutProvider
        bodyClassName="bg-muted"
        style={{
          '--sidebar-width': '255px',
          '--sidebar-header-height': '60px',
          '--header-height': '60px',
          '--header-height-mobile': '60px',
        } as React.CSSProperties}
      >
        <Wrapper />
      </LayoutProvider>
    </>
  );
}
