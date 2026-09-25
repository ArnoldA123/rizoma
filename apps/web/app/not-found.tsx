import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** 404 inside the shell, so a bad link never drops the chrome or the nav. */
export default function NotFound() {
  return (
    <div className="flex flex-col gap-7">
      <PageHeader
        eyebrow="404"
        title="Pantalla no encontrada"
        description="La ruta solicitada no existe en el registro de pantallas del MVP1. El registro es la única fuente de navegación, alcance y skin."
      />
      <div>
        <Link href="/" className={cn(buttonVariants({ variant: 'primary', size: 'md' }))}>
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}
