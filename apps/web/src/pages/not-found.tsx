import { Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/states';
import { Link } from '@/lib/router';

export default function NotFoundPage() {
  return (
    <EmptyState
      icon={<Compass aria-hidden />}
      title="Page not found"
      description="The page you are looking for does not exist."
      action={
        <Button asChild size="sm">
          <Link to="/">Go to overview</Link>
        </Button>
      }
    />
  );
}
