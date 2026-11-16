// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageDetail, MessageList, Filters, MailboxName } from '../../src/web/types';
import { TAXONOMY, deferred, detail, pagedList, status, summary } from './fixtures';

const mockApi = vi.hoisted(() => ({
  session: vi.fn(),
  localSession: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  status: vi.fn(),
  taxonomy: vi.fn(),
  saveTaxonomy: vi.fn(),
  reviewPolicy: vi.fn(),
  saveReviewPolicy: vi.fn(),
  connectGmail: vi.fn(),
  disconnectGmail: vi.fn(),
  messages: vi.fn(),
  message: vi.fn(),
  sync: vi.fn(),
  classify: vi.fn(),
  resetDemo: vi.fn(),
  reclassify: vi.fn(),
  correct: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
}));

vi.mock('../../src/web/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/web/api')>();
  return { ...actual, api: mockApi };
});

const { App } = await import('../../src/web/App');

type Page = { limit: number; offset: number };
/** Older clients passed a bare limit; normalize so the same tests run against them. */
const asPage = (page: Page | number): Page => (typeof page === 'number' ? { limit: page, offset: 0 } : page);

function setup(options: { mode?: 'local' | 'password'; total?: number } = {}) {
  const mode = options.mode ?? 'local';
  mockApi.session.mockResolvedValue({ authenticated: true, mode, csrfToken: 'csrf' });
  mockApi.status.mockResolvedValue(status({ auth: { mode } }));
  mockApi.taxonomy.mockResolvedValue(TAXONOMY);
  const serve = pagedList(options.total ?? 3);
  mockApi.messages.mockImplementation(async (_m: MailboxName, _f: Filters, page: Page | number) => serve(asPage(page)));
}

async function renderApp() {
  render(<App />);
  await screen.findByText('Subject 1');
}

const heading = () => screen.queryByRole('heading', { level: 2 })?.textContent ?? null;
const row = (subject: string) => screen.getByText(subject).closest('button')!;

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  for (const fn of Object.values(mockApi)) fn.mockReset();
});
afterEach(cleanup);

describe('message detail requests', () => {
  it('ignores an older detail response that resolves after a newer selection', async () => {
    setup();
    await renderApp();
    const a = deferred<MessageDetail>();
    const b = deferred<MessageDetail>();
    mockApi.message.mockImplementation((_m: MailboxName, id: number) => (id === 1 ? a.promise : b.promise));

    fireEvent.click(row('Subject 1'));
    fireEvent.click(row('Subject 2'));
    await act(async () => b.resolve(detail(2)));
    await waitFor(() => expect(heading()).toBe('Subject 2'));
    await act(async () => a.resolve(detail(1)));

    expect(heading()).toBe('Subject 2');
    expect(screen.queryByText('Body of message 1')).toBeNull();
  });

  it('drops a detail response after a mailbox switch, even for the same message id', async () => {
    setup();
    await renderApp();
    const gmailOne = deferred<MessageDetail>();
    const demoOne = deferred<MessageDetail>();
    mockApi.message.mockImplementation((mailbox: MailboxName) => (mailbox === 'gmail' ? gmailOne.promise : demoOne.promise));

    fireEvent.click(row('Subject 1'));
    fireEvent.click(screen.getByRole('tab', { name: 'Demo inbox' }));
    fireEvent.click(await waitFor(() => row('Subject 1')));
    await act(async () => gmailOne.resolve(detail(1, { body: { text: 'Gmail body', source: 'plain', truncated: false } })));

    expect(screen.queryByText('Gmail body')).toBeNull();
    await act(async () => demoOne.resolve(detail(1, { body: { text: 'Demo body', source: 'plain', truncated: false } })));
    expect(screen.getByText('Demo body')).toBeTruthy();
    expect(mockApi.message).toHaveBeenLastCalledWith('demo', 1);
  });

  it('drops a detail response after signing out and back in', async () => {
    setup({ mode: 'password' });
    await renderApp();
    const a = deferred<MessageDetail>();
    mockApi.message.mockReturnValue(a.promise);
    mockApi.logout.mockResolvedValue({ authenticated: false });
    mockApi.login.mockResolvedValue({ authenticated: true, mode: 'password', csrfToken: 'csrf2' });

    fireEvent.click(row('Subject 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.change(await screen.findByLabelText('App password'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
    await screen.findByText('Subject 1');
    await act(async () => a.resolve(detail(1)));

    expect(heading()).toBeNull();
  });

  it('does not let a slow correction for A replace B', async () => {
    setup();
    await renderApp();
    mockApi.message.mockImplementation(async (_m: MailboxName, id: number) => detail(id));
    const correction = deferred<MessageDetail>();
    mockApi.correct.mockReturnValue(correction.promise);

    fireEvent.click(row('Subject 1'));
    await waitFor(() => expect(heading()).toBe('Subject 1'));
    fireEvent.click(screen.getByRole('button', { name: /Correct/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save correction/ }));
    fireEvent.click(row('Subject 2'));
    await waitFor(() => expect(heading()).toBe('Subject 2'));
    await act(async () => correction.resolve(detail(1, { body: { text: 'Corrected A', source: 'plain', truncated: false } })));

    expect(heading()).toBe('Subject 2');
    expect(screen.queryByText('Corrected A')).toBeNull();
    expect(mockApi.correct).toHaveBeenCalledWith('gmail', 1, expect.objectContaining({ kind: 'edit', expectedDecisionSeq: 1 }));
  });
});

describe('label preview', () => {
  it('never shows or applies a late preview for A while B is displayed', async () => {
    setup();
    await renderApp();
    mockApi.message.mockImplementation(async (_m: MailboxName, id: number) => detail(id));
    const previewA = deferred<unknown>();
    mockApi.preview.mockReturnValue(previewA.promise);

    fireEvent.click(row('Subject 1'));
    await waitFor(() => expect(heading()).toBe('Subject 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview labels' }));
    fireEvent.click(row('Subject 2'));
    await waitFor(() => expect(heading()).toBe('Subject 2'));
    await act(async () =>
      previewA.resolve({
        previewId: 'pv_for_message_A_000',
        expiresAt: Date.now() + 60_000,
        simulated: false,
        canApply: true,
        blockedReason: null,
        labels: [{ field: 'category', name: 'Mail Triage/Category/FYI' }],
        toAdd: ['Mail Triage/Category/FYI'],
        alreadyPresent: [],
        existingNamespaced: [],
        notes: [],
      }),
    );

    expect(heading()).toBe('Subject 2');
    expect(screen.queryByText('Mail Triage/Category/FYI')).toBeNull();
    expect(screen.queryByRole('button', { name: /to this message/ })).toBeNull();
    expect(mockApi.apply).not.toHaveBeenCalled();
  });

  it('discards a preview when the same message gets a new decision before it resolves', async () => {
    setup();
    await renderApp();
    let seq = 1;
    mockApi.message.mockImplementation(async (_m: MailboxName, id: number) => detail(id, { decision: { ...summary(id).decision, decisionSeq: seq } }));
    const preview = deferred<unknown>();
    mockApi.preview.mockReturnValue(preview.promise);
    mockApi.reclassify.mockImplementation(async () => {
      seq = 2;
      return {
        ...detail(1, { decision: { ...summary(1).decision, decisionSeq: 2, sourceId: 11 }, body: { text: 'After reclassify', source: 'plain', truncated: false } }),
        outcome: 'classified',
      };
    });

    fireEvent.click(row('Subject 1'));
    await waitFor(() => expect(heading()).toBe('Subject 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Preview labels' }));
    fireEvent.click(screen.getByRole('button', { name: /Reclassify/ }));
    // The new decision is on screen before the old preview arrives.
    await screen.findByText('After reclassify');
    await act(async () =>
      preview.resolve({
        previewId: 'pv_for_old_decision_0',
        expiresAt: Date.now() + 60_000,
        simulated: false,
        canApply: true,
        blockedReason: null,
        labels: [{ field: 'category', name: 'Mail Triage/Category/FYI' }],
        toAdd: ['Mail Triage/Category/FYI'],
        alreadyPresent: [],
        existingNamespaced: [],
        notes: [],
      }),
    );

    expect(screen.queryByRole('button', { name: /to this message/ })).toBeNull();
    expect(mockApi.apply).not.toHaveBeenCalled();
  });
});

describe('pagination', () => {
  const showMore = () => screen.getByRole('button', { name: 'Show more' });
  const rowCount = () => document.querySelectorAll('.rows > li').length;

  it('pages through 151 messages in API-sized requests without gaps or duplicates', async () => {
    setup({ total: 151 });
    await renderApp();
    expect(rowCount()).toBe(50);

    for (const expected of [100, 150, 151]) {
      fireEvent.click(showMore());
      await waitFor(() => expect(rowCount()).toBe(expected));
    }
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    const subjects = [...document.querySelectorAll('.rows .row-subject')].map((el) => el.textContent);
    expect(new Set(subjects).size).toBe(151);
    expect(subjects[150]).toBe('Subject 151');
    for (const call of mockApi.messages.mock.calls) expect(asPage(call[2]).limit).toBeLessThanOrEqual(100);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps every loaded page after a refresh and resets when the query changes', async () => {
    setup({ total: 151 });
    mockApi.classify.mockResolvedValue({ attempted: 0, classified: 0, needsReview: 0, failed: 0, superseded: 0, remaining: 0, stoppedEarly: false });
    await renderApp();
    fireEvent.click(showMore());
    fireEvent.click(await waitFor(() => showMore()));
    await waitFor(() => expect(rowCount()).toBe(150));

    fireEvent.click(screen.getByRole('button', { name: 'Classify pending' }));
    await waitFor(() => expect(mockApi.classify).toHaveBeenCalled());
    await waitFor(() => expect(rowCount()).toBe(150));

    mockApi.messages.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Needs review/ }));
    await waitFor(() => expect(mockApi.messages).toHaveBeenCalledWith('gmail', expect.objectContaining({ state: 'needs_review' }), { limit: 50, offset: 0 }));
  });

  it('does not append a page from a previous query', async () => {
    setup({ total: 151 });
    await renderApp();
    const slow = deferred<MessageList>();
    mockApi.messages.mockImplementationOnce(() => slow.promise);
    fireEvent.click(showMore());
    const onlyTwo = pagedList(2);
    mockApi.messages.mockImplementation(async (_m: MailboxName, _f: Filters, page: Page | number) => onlyTwo(asPage(page)));
    fireEvent.change(screen.getByLabelText('Search messages'), { target: { value: 'Subject' } });
    await waitFor(() => expect(rowCount()).toBe(2));
    await act(async () => slow.resolve(pagedList(151)({ limit: 50, offset: 50 })));

    expect(rowCount()).toBe(2);
  });
});

describe('rows and detail stay in agreement', () => {
  it('marks only the selected row and shows its detail', async () => {
    setup();
    await renderApp();
    mockApi.message.mockImplementation(async (_m: MailboxName, id: number) => detail(id));
    fireEvent.click(row('Subject 3'));
    await waitFor(() => expect(heading()).toBe('Subject 3'));
    const current = document.querySelector('.row.selected');
    expect(current && within(current as HTMLElement).getByText('Subject 3')).toBeTruthy();
  });
});

describe('missing messages', () => {
  it('returns to the list when the selected message no longer exists', async () => {
    setup();
    const { ApiError } = await import('../../src/web/api');
    window.history.replaceState(null, '', '/#gmail/999');
    mockApi.message.mockRejectedValue(new ApiError(404, 'not_found', 'Message not found'));
    render(<App />);
    await screen.findByText('Message not found');
    await waitFor(() => expect(window.location.hash).toBe('#gmail'));
    expect(screen.getByText('Select a message to review its classification.')).toBeTruthy();
  });
});

describe('repeat visits and same-message ordering', () => {
  const withBody = (id: number, text: string) => detail(id, { body: { text, source: 'plain', truncated: false } });
  const classifyStats = { attempted: 0, classified: 0, needsReview: 0, failed: 0, superseded: 0, remaining: 0, stoppedEarly: false };

  it('does not revive a read from an earlier visit after going A → B → A', async () => {
    setup();
    await renderApp();
    const oldA = deferred<MessageDetail>();
    const newA = deferred<MessageDetail>();
    let aCalls = 0;
    mockApi.message.mockImplementation((_m: MailboxName, id: number) =>
      id === 1 ? (++aCalls === 1 ? oldA.promise : newA.promise) : Promise.resolve(detail(2)),
    );

    fireEvent.click(row('Subject 1'));
    fireEvent.click(row('Subject 2'));
    await waitFor(() => expect(heading()).toBe('Subject 2'));
    fireEvent.click(row('Subject 1'));
    await act(async () => newA.resolve(withBody(1, 'CURRENT A')));
    await screen.findByText('CURRENT A');
    await act(async () => oldA.resolve(withBody(1, 'STALE A')));

    expect(screen.queryByText('STALE A')).toBeNull();
    expect(screen.getByText('CURRENT A')).toBeTruthy();
  });

  it('lets the newest read of the same message win', async () => {
    setup();
    mockApi.classify.mockResolvedValue(classifyStats);
    await renderApp();
    const first = deferred<MessageDetail>();
    const second = deferred<MessageDetail>();
    mockApi.message.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    fireEvent.click(row('Subject 1'));
    // Classify pending reloads the selected message after the run.
    fireEvent.click(screen.getByRole('button', { name: 'Classify pending' }));
    await waitFor(() => expect(mockApi.message).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(withBody(1, 'NEWER READ')));
    await screen.findByText('NEWER READ');
    await act(async () => first.resolve(withBody(1, 'OLDER READ')));

    expect(screen.queryByText('OLDER READ')).toBeNull();
    expect(screen.getByText('NEWER READ')).toBeTruthy();
  });

  it('does not let a read started before a correction overwrite the saved correction', async () => {
    setup();
    mockApi.classify.mockResolvedValue(classifyStats);
    await renderApp();
    const reload = deferred<MessageDetail>();
    mockApi.message.mockResolvedValueOnce(detail(1)).mockReturnValueOnce(reload.promise);
    mockApi.correct.mockResolvedValue(withBody(1, 'SAVED CORRECTION'));

    fireEvent.click(row('Subject 1'));
    await waitFor(() => expect(heading()).toBe('Subject 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Classify pending' }));
    await waitFor(() => expect(mockApi.message).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /Correct/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save correction/ }));
    await screen.findByText('SAVED CORRECTION');
    await act(async () => reload.resolve(withBody(1, 'PRE-CORRECTION READ')));

    expect(screen.queryByText('PRE-CORRECTION READ')).toBeNull();
    expect(screen.getByText('SAVED CORRECTION')).toBeTruthy();
  });

  it('drops a mutation result from the first visit to A after returning to A', async () => {
    setup();
    await renderApp();
    let aCalls = 0;
    mockApi.message.mockImplementation(async (_m: MailboxName, id: number) =>
      id === 1 ? withBody(1, ++aCalls === 1 ? 'FIRST VISIT' : 'SECOND VISIT') : detail(2),
    );
    const correction = deferred<MessageDetail>();
    mockApi.correct.mockReturnValue(correction.promise);

    fireEvent.click(row('Subject 1'));
    await screen.findByText('FIRST VISIT');
    fireEvent.click(screen.getByRole('button', { name: /Correct/ }));
    fireEvent.click(screen.getByRole('button', { name: /Save correction/ }));
    fireEvent.click(row('Subject 2'));
    await waitFor(() => expect(heading()).toBe('Subject 2'));
    fireEvent.click(row('Subject 1'));
    await screen.findByText('SECOND VISIT');
    await act(async () => correction.resolve(withBody(1, 'FIRST VISIT CORRECTION')));

    expect(screen.queryByText('FIRST VISIT CORRECTION')).toBeNull();
    expect(screen.getByText('SECOND VISIT')).toBeTruthy();
  });
});
