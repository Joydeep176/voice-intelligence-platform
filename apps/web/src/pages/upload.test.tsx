import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToastProvider } from '@/components/toaster';
import { json, mockFetch, problem, recording } from '@/test/mock-api';
import UploadPage, { resolveMimeType } from './upload';

const renderPage = () =>
  render(
    <ToastProvider>
      <UploadPage />
    </ToastProvider>,
  );

const wavFile = (bytes = 10) =>
  new File([new Uint8Array(bytes)], 'synthetic-tone.wav', { type: 'audio/wav' });

function uploadApi(onComplete: () => Response = () => json(200, recording())) {
  const rec = recording({ status: 'uploading', latestRun: null });
  return mockFetch((method, url) => {
    if (method === 'POST' && url.pathname.endsWith('/recordings')) {
      return json(201, {
        recording: rec,
        upload: {
          strategy: 'local_chunked',
          status: 'active',
          partSize: 4,
          totalParts: 3,
          partsReceived: [],
          expiresAt: rec.createdAt,
        },
      });
    }
    if (method === 'PUT' && url.pathname.includes('/upload/parts/')) {
      return json(200, { partNumber: Number(url.pathname.split('/').pop()), sizeBytes: 4 });
    }
    if (method === 'POST' && url.pathname.endsWith('/upload/complete')) return onComplete();
    return undefined;
  });
}

describe('UploadPage', () => {
  it('requires a file and the consent attestation before uploading', async () => {
    uploadApi();
    const user = userEvent.setup();
    renderPage();
    const submit = screen.getByRole('button', { name: 'Upload' });
    expect(submit).toBeDisabled();
    await user.upload(screen.getByLabelText('Audio file'), wavFile());
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    expect(submit).toBeEnabled();
  });

  it('rejects unsupported files on the client', async () => {
    uploadApi();
    const user = userEvent.setup({ applyAccept: false });
    renderPage();
    await user.upload(
      screen.getByLabelText('Audio file'),
      new File(['x'], 'notes.txt', { type: 'text/plain' }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported file type');
  });

  it('uploads in parts with consent, then shows an honest success state', async () => {
    const fetchMock = uploadApi();
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText('Audio file'), wavFile(10));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Upload' }));

    expect(await screen.findByRole('heading', { name: /upload complete/i })).toBeInTheDocument();
    expect(screen.getByText(/has not been transcribed or analysed/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View recording' })).toHaveAttribute(
      'href',
      `/recordings/${recording().id}`,
    );

    const calls = fetchMock.mock.calls.map(
      ([u, init]) =>
        `${init?.method ?? 'GET'} ${new URL(String(u), 'http://x').pathname.split('/recordings')[1] ?? ''}`,
    );
    expect(calls).toEqual([
      'POST ',
      `PUT /${recording().id}/upload/parts/1`,
      `PUT /${recording().id}/upload/parts/2`,
      `PUT /${recording().id}/upload/parts/3`,
      `POST /${recording().id}/upload/complete`,
    ]);
    const createBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(createBody).toMatchObject({
      filename: 'synthetic-tone.wav',
      mimeType: 'audio/wav',
      sizeBytes: 10,
      consent: { attested: true },
    });
  });

  it('shows a friendly, fixed message when the server rejects the file', async () => {
    uploadApi(() => problem(422, 'MEDIA_SIGNATURE_MISMATCH', 'raw server title'));
    const user = userEvent.setup();
    renderPage();
    await user.upload(screen.getByLabelText('Audio file'), wavFile(10));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect((await screen.findAllByText(/does not match its audio format/i)).length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText('raw server title')).not.toBeInTheDocument();
  });
});

describe('resolveMimeType', () => {
  it('uses the browser type, then the extension', () => {
    expect(resolveMimeType({ name: 'a.wav', type: 'audio/x-wav' })).toBe('audio/x-wav');
    expect(resolveMimeType({ name: 'a.M4A', type: '' })).toBe('audio/mp4');
    expect(resolveMimeType({ name: 'a.txt', type: 'text/plain' })).toBeNull();
  });
});
