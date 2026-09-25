import { Card, CardContent, CardDescription, CardEyebrow, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { actionLabel } from '@/lib/labels';
import type { ActionCode } from '@/lib/access';

/**
 * Stub panel — the placeholder a W2–W5 screen renders until its task lands.
 *
 * It states the ODD task that owns the screen, the endpoints that task will
 * consume and, most importantly, which capabilities the current role holds
 * versus lacks. A placeholder that says "próximamente" hides the interesting
 * part; this one shows the contract the screen is going to satisfy.
 */
export interface StubPanelProps {
  readonly title: string;
  readonly task: string;
  readonly description: string;
  /** What the owning task delivers on this screen. */
  readonly deliverables: readonly string[];
  /** `METHOD /v1/path` list the screen will call. */
  readonly endpoints: readonly string[];
  /** Actions of this screen's rule the role holds. */
  readonly permitted: readonly ActionCode[];
  /** Actions of this screen's rule the role lacks. */
  readonly missing: readonly ActionCode[];
}

export function StubPanel({
  title,
  task,
  description,
  deliverables,
  endpoints,
  permitted,
  missing,
}: StubPanelProps) {
  return (
    <Card tone="accent">
      <CardHeader>
        <CardEyebrow>{task} · pendiente</CardEyebrow>
        <CardTitle as="h2" className="text-base">
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>

      <CardContent className="grid gap-5 sm:grid-cols-2">
        <section>
          <h3 className="mb-2 text-[0.8125rem] font-semibold">Alcance de la tarea</h3>
          <ul className="flex flex-col gap-1.5 text-[0.8125rem] text-muted-foreground">
            {deliverables.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="mb-2 text-[0.8125rem] font-semibold">Endpoints que consumirá</h3>
          <ul className="tabular flex flex-col gap-1.5 font-mono text-[0.75rem] text-muted-foreground">
            {endpoints.map((endpoint) => (
              <li key={endpoint} className="break-all">
                {endpoint}
              </li>
            ))}
          </ul>
        </section>
      </CardContent>

      <CardFooter className="gap-2">
        {permitted.map((action) => (
          <Badge key={action} variant="tinted" title={action}>
            {actionLabel(action)}
          </Badge>
        ))}
        {missing.map((action) => (
          <Badge key={action} variant="outline" title={action} className="line-through opacity-70">
            {actionLabel(action)}
          </Badge>
        ))}
      </CardFooter>
    </Card>
  );
}
