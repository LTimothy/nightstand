import { Link } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';

const sx = { display: 'inline-flex', minHeight: 44, alignItems: 'center' };

// The line under a switch that waits on another one. A same-page anchor scrolls natively; another page goes through the router.
export default function TurnOnFirst({ parent, href }: { parent: string; href: string }) {
  const text = `Turn on ${parent} first`;
  return href.startsWith('#')
    ? <Link
      href={ href }
      sx={ sx }>{ text }</Link>
    : <Link
      component={ RouterLink }
      to={ href }
      sx={ sx }>{ text }</Link>;
}
