import { Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Link } from '@/lib/router';
import { HeroVisual } from './hero-visual';

const LANGUAGES = ['English', 'हिन्दी', 'Hinglish'];

export function Hero() {
  return (
    <section
      data-dashboard-hero
      aria-labelledby="overview-title"
      className="bg-card relative isolate overflow-hidden rounded-2xl shadow-md ring-1 ring-foreground/10"
    >
      {/* The one gradient surface: brand colour at low opacity under the card background. */}
      <div
        aria-hidden
        className="bg-brand-gradient absolute inset-0 -z-10 opacity-[0.07] dark:opacity-[0.12]"
      />
      <div className="grid items-center gap-8 p-6 sm:p-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-12">
        <div className="grid gap-6">
          <div className="grid gap-3">
            <h1
              id="overview-title"
              className="text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase"
            >
              Overview
            </h1>
            <p className="text-3xl leading-[1.1] font-semibold tracking-tight text-balance sm:text-4xl lg:text-[2.75rem]">
              Understand every conversation, across English, हिन्दी and Hinglish.
            </p>
            <p className="text-muted-foreground max-w-prose text-sm leading-relaxed sm:text-base">
              Upload consented or synthetic recordings today. Audio understanding, context analysis
              and evidence-backed intelligence arrive in later phases.
            </p>
          </div>
          <ul aria-label="Supported languages" className="flex flex-wrap gap-2">
            {LANGUAGES.map((l) => (
              <li
                key={l}
                className="bg-background/70 text-foreground rounded-full px-3 py-1 text-xs font-medium ring-1 ring-foreground/10"
              >
                {l}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/recordings/new">
                <Upload aria-hidden data-icon="inline-start" />
                Upload recording
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link to="/recordings">View recordings</Link>
            </Button>
          </div>
        </div>
        <HeroVisual />
      </div>
    </section>
  );
}
