import { runArchiveChats } from '../src/cli/commands/archiveChats';
import * as chatArchiver from '../src/notebooklm/chatArchiver';

jest.mock('../src/notebooklm/chatArchiver');

describe('runArchiveChats isolation tests', () => {
  const mockedArchiver = chatArchiver as jest.Mocked<typeof chatArchiver>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reports success when all notebooks succeed in universal sweep', async () => {
    mockedArchiver.runUniversalChatArchival.mockResolvedValueOnce({
      results: [
        {
          notebookId: 'nb-1',
          notebookTitle: 'NB 1',
          sessionCount: 1,
          totalTurns: 5,
          noteCreated: true,
          skipped: false,
        },
        {
          notebookId: 'nb-2',
          notebookTitle: 'NB 2',
          sessionCount: 0,
          totalTurns: 0,
          noteCreated: false,
          skipped: true,
          skipReason: 'No turns',
        },
      ],
      totalProcessed: 1,
      totalTurns: 5,
    });

    const res = await runArchiveChats('C:/dev/trm', undefined, { all: true });
    expect(res.success).toBe(true);
    expect(res.message).toContain('0 errors');
  });

  it('isolates single-notebook timeout errors without failing the universal sweep', async () => {
    mockedArchiver.runUniversalChatArchival.mockResolvedValueOnce({
      results: [
        {
          notebookId: 'nb-1',
          notebookTitle: 'NB 1',
          sessionCount: 1,
          totalTurns: 10,
          noteCreated: true,
          skipped: false,
        },
        {
          notebookId: 'nb-2',
          notebookTitle: 'NB 2 Timeout',
          sessionCount: 0,
          totalTurns: 0,
          noteCreated: false,
          skipped: true,
          error: 'Failed to list chats: spawnSync nlm ETIMEDOUT',
        },
        {
          notebookId: 'nb-3',
          notebookTitle: 'NB 3',
          sessionCount: 1,
          totalTurns: 4,
          noteCreated: true,
          skipped: false,
        },
      ],
      totalProcessed: 2,
      totalTurns: 14,
    });

    const res = await runArchiveChats('C:/dev/trm', undefined, { all: true });
    expect(res.success).toBe(true);
    expect(res.results.length).toBe(3);
    expect(res.message).toContain('1 isolated error(s) tolerated');
  });

  it('fails the sweep when all notebooks error (catastrophic failure)', async () => {
    mockedArchiver.runUniversalChatArchival.mockResolvedValueOnce({
      results: [
        {
          notebookId: 'nb-1',
          notebookTitle: 'NB 1',
          sessionCount: 0,
          totalTurns: 0,
          noteCreated: false,
          skipped: true,
          error: 'Auth expired',
        },
        {
          notebookId: 'nb-2',
          notebookTitle: 'NB 2',
          sessionCount: 0,
          totalTurns: 0,
          noteCreated: false,
          skipped: true,
          error: 'Auth expired',
        },
      ],
      totalProcessed: 0,
      totalTurns: 0,
    });

    const res = await runArchiveChats('C:/dev/trm', undefined, { all: true });
    expect(res.success).toBe(false);
  });
});
