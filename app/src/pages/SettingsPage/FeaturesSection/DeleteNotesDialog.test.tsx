import { expect, it } from 'vitest';
import { delay, http, HttpResponse } from 'msw';
import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import { renderWithProviders } from '@test/renderWithProviders';
import { server } from '@test/setup';
import DeleteNotesDialog from './DeleteNotesDialog';

function Host() {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={ () => setOpen(true) }>Delete notes</button>
    { open && <DeleteNotesDialog onClose={ () => setOpen(false) }/> }
  </>;
}
const openDialog = async (user: ReturnType<typeof renderWithProviders>['user']) => {
  await user.click(screen.getByRole('button', { name: 'Delete notes' }));
  return within(await screen.findByRole('dialog'));
};

it('keeps focus on the button and ignores a second click while deleting', async () => {
  let posts = 0;
  server.use(http.post('*/rhythms/suggestions/forget', async () => {
    posts += 1;
    await delay(100);
    return new HttpResponse(null, { status: 204 });
  }));
  const { user } = renderWithProviders(<Host/>);
  const dialog = await openDialog(user);
  const confirm = dialog.getByRole('button', { name: 'Delete notes' });
  await user.click(confirm);
  expect(confirm).toHaveAttribute('aria-disabled', 'true');
  expect(confirm).toHaveFocus();
  await user.click(confirm);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(posts).toBe(1);
});

it('stays open with the error in the dialog when deleting fails, and closes on a retry that works', async () => {
  let fail = true;
  server.use(http.post('*/rhythms/suggestions/forget', () => fail
    ? HttpResponse.json({ error: 'nope' }, { status: 500 }) : new HttpResponse(null, { status: 204 })));
  const { user } = renderWithProviders(<Host/>);
  const dialog = await openDialog(user);
  await user.click(dialog.getByRole('button', { name: 'Delete notes' }));
  expect(await dialog.findByRole('alert')).toHaveTextContent('Could not delete notes. Try again.');
  expect(dialog.getByRole('button', { name: 'Delete notes' })).toHaveAttribute('aria-disabled', 'false');
  fail = false;
  await user.click(dialog.getByRole('button', { name: 'Delete notes' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('returns focus to the opening button after Cancel', async () => {
  const { user } = renderWithProviders(<Host/>);
  const dialog = await openDialog(user);
  await user.click(dialog.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Delete notes' })).toHaveFocus());
});
