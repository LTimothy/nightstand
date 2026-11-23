import { ReactNode } from 'react';
import { Box, Button, List, ListItemButton, ListItemText, useMediaQuery } from '@mui/material';
import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import { useTheme } from '@mui/material/styles';
import { Link, useLocation } from 'react-router-dom';
import { SETTINGS_CATEGORIES } from '../SettingsPage/settingsCategories';
import PageContainer from '../PageContainer.tsx';
import PageHeader from '@components/PageHeader';

type HeaderProps = { title: string; icon?: ReactNode; backTo?: string; backLabel?: string };

export default function Header({ title, backTo = '/settings', backLabel = 'Back to Settings' }: HeaderProps) {
  return <Box sx={ { width: '100%' } }>
    { backTo && <Button
      component={ Link }
      to={ backTo }
      startIcon={ <NavigateBeforeIcon/> }
      sx={ { mb: 1, px: 0, minHeight: 44, display: { lg: 'none' } } }>
      { backLabel }
    </Button> }
    <PageHeader title={ title }/>
  </Box>;
}

// Shared reading width and heading for settings and diagnostic destinations.
// eslint-disable-next-line react/no-multi-comp
export function SubpageShell({ children, ...header }: HeaderProps & { children: ReactNode }) {
  const desktop = useMediaQuery(useTheme().breakpoints.up('lg'));
  const { pathname } = useLocation();
  const category = pathname === '/changelog' ? 'versions'
    : ['/settings/system', '/settings/logs'].includes(pathname) ? 'device' : pathname.split('/')[2];
  return <Box sx={ { position: 'relative', width: '100%', maxWidth: 720, mx: 'auto' } }>
    { desktop && header.backTo !== '' && <Box
      component="nav"
      aria-label="Settings categories"
      sx={ { position: 'absolute', right: '100%', width: 224, top: 24, px: 1 } }>
      <List sx={ { p: 0 } }>{ SETTINGS_CATEGORIES.map(({ key, title }) => <ListItemButton
        key={ key }
        component={ Link }
        to={ `/settings/${key}` }
        selected={ category === key }
        aria-current={ category === key ? 'page' : undefined }
        sx={ { minHeight: 44, borderRadius: 1 } }
      ><ListItemText primary={ title } /></ListItemButton>) }
      <ListItemButton
        component={ Link }
        to="/settings/about"
        selected={ category === 'about' }
        aria-current={ category === 'about' ? 'page' : undefined }
        sx={ { borderRadius: 1 } }>
        <ListItemText primary="About and license"/>
      </ListItemButton></List>
    </Box> }
    <PageContainer sx={ { minWidth: 0, alignItems: 'stretch', gap: 2 } }>
      <Header { ...header } />
      { children }
    </PageContainer>
  </Box>;
}
