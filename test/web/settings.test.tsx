// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaxonomyRevision } from '../../src/web/types';
import { TAXONOMY, status } from './fixtures';

const mockApi = vi.hoisted(() => ({ saveTaxonomy: vi.fn(), taxonomy: vi.fn(), reviewPolicy: vi.fn() }));
vi.mock('../../src/web/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/api')>();
  return { ...actual, api: mockApi };
});
const { Settings } = await import('../../src/web/components/Settings');

const props = (taxonomy: TaxonomyRevision) => ({
  status: status(),
  taxonomy,
  notify: vi.fn(),
  onError: vi.fn(),
  onChanged: vi.fn(async () => {}),
  onClose: vi.fn(),
});

const contextBox = () => screen.getByLabelText(/About you/) as HTMLTextAreaElement;
const firstName = () => screen.getAllByLabelText('Category name')[0] as HTMLInputElement;

function revision(n: number, userContext: string): TaxonomyRevision {
  return { ...structuredClone(TAXONOMY), revision: n, hash: `h${n}`, taxonomy: { ...structuredClone(TAXONOMY.taxonomy), userContext } };
}

beforeEach(() => {
  for (const fn of Object.values(mockApi)) fn.mockReset();
});
afterEach(cleanup);

describe('category editor draft', () => {
  it('keeps unsaved edits when a status refresh delivers an equal taxonomy object', () => {
    const { rerender } = render(<Settings {...props(TAXONOMY)} />);
    fireEvent.change(contextBox(), { target: { value: 'Edited context' } });
    fireEvent.change(firstName(), { target: { value: 'Updates' } });

    rerender(<Settings {...props(structuredClone(TAXONOMY))} />);

    expect(contextBox().value).toBe('Edited context');
    expect(firstName().value).toBe('Updates');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks before replacing a dirty draft when the revision changes, and discard loads the new revision', () => {
    const { rerender } = render(<Settings {...props(TAXONOMY)} />);
    fireEvent.change(contextBox(), { target: { value: 'Edited context' } });

    rerender(<Settings {...props(revision(2, 'Changed elsewhere'))} />);

    expect(screen.getByRole('alert').textContent).toMatch(/revision 2/);
    expect(contextBox().value).toBe('Edited context');
    expect((screen.getByRole('button', { name: 'Save categories' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Discard my edits and load revision 2/ }));
    expect(contextBox().value).toBe('Changed elsewhere');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('can keep the edits and save them against the new revision', async () => {
    mockApi.saveTaxonomy.mockImplementation(async (expected: number, taxonomy: TaxonomyRevision['taxonomy']) => ({
      revision: expected + 1,
      hash: 'h3',
      createdAt: 0,
      taxonomy,
      changed: true,
    }));
    const { rerender } = render(<Settings {...props(TAXONOMY)} />);
    fireEvent.change(contextBox(), { target: { value: 'Edited context' } });
    rerender(<Settings {...props(revision(2, 'Changed elsewhere'))} />);

    fireEvent.click(screen.getByRole('button', { name: /Keep my edits/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save categories' }));

    await waitFor(() => expect(mockApi.saveTaxonomy).toHaveBeenCalledWith(2, expect.objectContaining({ userContext: 'Edited context' })));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save categories' }) as HTMLButtonElement).disabled).toBe(true));
    expect(contextBox().value).toBe('Edited context');
  });

  it('replaces a clean draft when the revision changes, without asking', () => {
    const { rerender } = render(<Settings {...props(TAXONOMY)} />);
    rerender(<Settings {...props(revision(2, 'Changed elsewhere'))} />);
    expect(contextBox().value).toBe('Changed elsewhere');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the conflict choice when a save races another edit', async () => {
    const { ApiError } = await import('../../src/web/api');
    mockApi.saveTaxonomy.mockRejectedValue(new ApiError(409, 'stale_revision', 'Configuration changed'));
    mockApi.taxonomy.mockResolvedValue(revision(5, 'Saved by someone else'));
    render(<Settings {...props(TAXONOMY)} />);
    fireEvent.change(contextBox(), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save categories' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/revision 5/);
    expect(contextBox().value).toBe('Mine');
  });
});
