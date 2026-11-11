import {
  getLyricsSnapshot,
  getPlayerSnapshot,
  getQueueWindow,
  playerActions,
  type QueueWindow,
} from '@/features/player/store';
import { findActiveLyricIndex, loadLyricLines } from '@/features/player/lyrics';
import { playCollection } from '@/features/player/play-collection';
import type { LyricLine, PlayMode, PlayerTrack } from '@/features/player/types';
import { isTrackLiked, libraryActions } from '@/features/library/store';
import { searchPlaylists, searchSongs } from '@/features/search/search-api';
import { fetchPlaylistTracks } from '@/features/playlist/playlist-api';
import { loadDailyRecommendSongs } from '@/features/home/load-home-data';

/** GCP client tool 声明（shared/protocol/gateway-client-protocol.mjs: GatewayClientToolSchema）。 */
export type ClientToolManifest = {
  name: string;
  description: string;
  inputSchema: { type: 'object' } & Record<string, unknown>;
  response_on_success?: 'auto' | 'none';
};

/** executeTool 的返回，对应 client.action.result 的 status/output/error。 */
export type ToolResult =
  | { status: 'completed'; output?: unknown }
  | { status: 'failed'; error: { code: string; message: string } }
  | { status: 'unsupported'; error: { code: string; message: string } };

const TOOL_PREFIX = 'client.tool.';

const EMPTY_SCHEMA = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
};

export const VOICE_TOOLS: ClientToolManifest[] = [
  {
    name: 'player_control',
    description:
      '控制音乐播放。command: play=播放/继续, pause=暂停, next=下一首, previous=上一首。',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          enum: ['play', 'pause', 'next', 'previous'],
          description: 'play=播放/继续, pause=暂停, next=下一首, previous=上一首',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'player_stop',
    description: '停止播放并清空当前播放队列。',
    inputSchema: EMPTY_SCHEMA,
    response_on_success: 'auto',
  },
  {
    name: 'player_set_mode',
    description: '设置播放模式。sequence=顺序播放, shuffle=随机播放, single=单曲循环。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['sequence', 'shuffle', 'single'],
          description: 'sequence=顺序播放, shuffle=随机播放, single=单曲循环',
        },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'player_seek',
    description:
      '调整当前歌曲的播放进度。二选一：position_seconds=绝对时间点（秒，从歌曲开头算起，可配合歌词时间戳跳到某句）；delta_seconds=相对当前进度的偏移（正数快进、负数快退）。',
    inputSchema: {
      type: 'object',
      properties: {
        position_seconds: {
          type: 'number',
          minimum: 0,
          description: '绝对时间点（秒），从歌曲开头算起。与 delta_seconds 二选一。',
        },
        delta_seconds: {
          type: 'number',
          description: '相对当前进度的偏移秒数，正数快进、负数快退。与 position_seconds 二选一。',
        },
      },
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'player_set_volume',
    description: '设置音乐播放音量。',
    inputSchema: {
      type: 'object',
      properties: {
        volume: { type: 'number', minimum: 0, maximum: 1, description: '音量，0 到 1 之间。' },
      },
      required: ['volume'],
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'player_get_state',
    description:
      '获取当前播放状态：曲目（曲名/歌手/专辑）、是否正在播放、播放模式、进度、音量、以及在队列中的位置。',
    inputSchema: EMPTY_SCHEMA,
    response_on_success: 'auto',
  },
  {
    name: 'player_get_queue',
    description: '分页列出播放队列中的歌曲（含每首的绝对下标、曲名、歌手、时长）。',
    inputSchema: {
      type: 'object',
      properties: {
        offset: { type: 'integer', minimum: 0, description: '起始下标，默认从当前曲目开始。' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '返回条数，默认 20，最多 50。' },
      },
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'track_set_like',
    description:
      '把当前正在播放的歌曲加入或移出「我喜欢」。用户说"喜欢这首歌/收藏"时 liked=true；说"取消喜欢/不喜欢了"时 liked=false。需要已登录。',
    inputSchema: {
      type: 'object',
      properties: {
        liked: {
          type: 'boolean',
          description: 'true=喜欢/收藏当前歌曲，false=取消喜欢。不填时默认 true。',
        },
      },
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'track_get_lyrics',
    description:
      '获取当前正在播放歌曲的歌词（带时间戳），并标记当前正在演唱的那一句及其时间点。返回 current（当前句：index/time_seconds/text）与 lines（全部歌词行，每行含 time_seconds/text，current=true 标记正在唱的行）。用于展示歌词，无需逐行朗读。',
    inputSchema: EMPTY_SCHEMA,
    response_on_success: 'auto',
  },
  {
    name: 'music_search_songs',
    description:
      '按关键词搜索歌曲，返回候选列表（曲名/歌手/专辑），用于查找或让用户挑选，不会自动播放。要播放请用 music_play_songs。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，如歌名、歌手，或两者组合。' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 8，最多 20。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'music_search_playlists',
    description:
      '按关键词搜索歌单，返回候选列表（歌单 id/名称/创建者/歌曲数）。返回的 id 可直接用于 music_play_playlist。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌单搜索关键词。' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认 8，最多 20。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'music_play_songs',
    description:
      '搜索并播放歌曲：按 query 搜索，从第 index 个结果（默认第 1 个）开始播放，并把后续搜索结果排入队列继续播放。用户说「播放某首歌/某个歌手的歌」时用这个。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要播放的歌曲关键词（歌名、歌手或组合）。' },
        index: { type: 'integer', minimum: 0, description: '从第几个搜索结果开始播放，0 表示第一个，默认 0。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'music_play_playlist',
    description:
      '播放一个歌单（把歌单曲目作为新队列从头播放）。二选一提供定位方式：id=已知歌单 id（如来自 music_search_playlists 的结果）；query=按名称搜索歌单并播放匹配到的那个（可用 index 指定第几个，默认第一个）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '歌单 id。与 query 二选一。' },
        query: { type: 'string', description: '歌单名称关键词，用于搜索后播放。与 id 二选一。' },
        index: { type: 'integer', minimum: 0, description: '按 query 搜索时，播放第几个结果，默认 0。' },
      },
      additionalProperties: false,
    },
    response_on_success: 'auto',
  },
  {
    name: 'music_play_daily_recommend',
    description: '播放「每日推荐」歌单（当天的个性化推荐歌曲），作为新队列从头播放。用户说「放每日推荐/今天推荐什么」时用这个。',
    inputSchema: EMPTY_SCHEMA,
    response_on_success: 'auto',
  },
];

function completed(output?: unknown): ToolResult {
  return output === undefined ? { status: 'completed' } : { status: 'completed', output };
}

function failed(code: string, message: string): ToolResult {
  return { status: 'failed', error: { code, message } };
}

function toNumber(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : (value as number);
  return typeof num === 'number' && Number.isFinite(num) ? num : null;
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

function serializeState() {
  const snapshot = getPlayerSnapshot();
  return {
    track: snapshot.track
      ? {
          title: snapshot.track.title,
          artist: snapshot.track.artist,
          album: snapshot.track.album,
        }
      : null,
    playing: snapshot.playing,
    mode: snapshot.mode,
    progress: {
      position_seconds: seconds(snapshot.positionMs),
      duration_seconds: seconds(snapshot.durationMs),
    },
    volume: Math.round(snapshot.volume * 100) / 100,
    queue: { index: snapshot.queueIndex, length: snapshot.queueLength },
  };
}

function serializeQueue(window: QueueWindow) {
  return {
    total: window.total,
    current_index: window.currentIndex,
    offset: window.offset,
    items: window.items.map((item) => ({
      index: item.index,
      title: item.title,
      artist: item.artist,
      duration_seconds: item.durationMs != null ? seconds(item.durationMs) : null,
    })),
  };
}

/** 播放类工具执行后回报「现在在放什么」，供 agent 口头确认。 */
function serializeNowPlaying() {
  const snapshot = getPlayerSnapshot();
  return {
    now_playing: snapshot.track
      ? { title: snapshot.track.title, artist: snapshot.track.artist }
      : null,
    queue_index: snapshot.queueIndex,
    queue_length: snapshot.queueLength,
  };
}

/** 优先复用已加载的歌词，未加载时按当前曲目现拉一次。 */
async function resolveLyrics(track: PlayerTrack): Promise<LyricLine[]> {
  const snapshot = getLyricsSnapshot();
  if (snapshot.status === 'ready' && snapshot.lines.length) {
    return snapshot.lines;
  }
  return loadLyricLines(track);
}

/**
 * 执行一个来自 Gateway 的 client tool 调用。
 * fullName 形如 `client.tool.player_control`；arguments 为模型给出的参数对象。
 * 多数工具同步返回；涉及网络的（如点喜欢）返回 Promise。
 */
export function executeTool(fullName: string, args: unknown): ToolResult | Promise<ToolResult> {
  const name = fullName.startsWith(TOOL_PREFIX) ? fullName.slice(TOOL_PREFIX.length) : fullName;
  const params: Record<string, unknown> =
    args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

  switch (name) {
    case 'player_control': {
      const snapshot = getPlayerSnapshot();
      if (!snapshot.track) {
        return failed('no_track', '当前没有可播放的歌曲，请先搜索或选择歌曲。');
      }
      const command = String(params.command ?? '');
      switch (command) {
        case 'play':
          playerActions.play();
          return completed({ command, playing: true });
        case 'pause':
          playerActions.pause();
          return completed({ command, playing: false });
        case 'next':
          playerActions.next();
          return completed({ command });
        case 'previous':
          playerActions.previous();
          return completed({ command });
        default:
          return failed('invalid_arguments', `未知的播放命令: ${command || '(空)'}`);
      }
    }

    case 'player_stop':
      playerActions.clearQueue();
      return completed({ stopped: true });

    case 'player_set_mode': {
      const mode = String(params.mode ?? '') as PlayMode;
      if (mode !== 'sequence' && mode !== 'shuffle' && mode !== 'single') {
        return failed('invalid_arguments', `未知的播放模式: ${String(params.mode ?? '(空)')}`);
      }
      playerActions.setMode(mode);
      return completed({ mode });
    }

    case 'player_seek': {
      const snapshot = getPlayerSnapshot();
      if (!snapshot.track) {
        return failed('no_track', '当前没有可播放的歌曲。');
      }
      const hasPosition = params.position_seconds !== undefined && params.position_seconds !== null;
      const hasDelta = params.delta_seconds !== undefined && params.delta_seconds !== null;
      if (hasPosition === hasDelta) {
        return failed(
          'invalid_arguments',
          '请提供 position_seconds（绝对时间点）或 delta_seconds（相对偏移）其中之一。',
        );
      }

      let targetMs: number;
      if (hasPosition) {
        const position = toNumber(params.position_seconds);
        if (position === null) {
          return failed('invalid_arguments', 'position_seconds 必须是数字（秒）。');
        }
        targetMs = Math.max(0, position * 1000);
      } else {
        const delta = toNumber(params.delta_seconds);
        if (delta === null) {
          return failed('invalid_arguments', 'delta_seconds 必须是数字（秒）。');
        }
        targetMs = Math.max(0, snapshot.positionMs + delta * 1000);
      }
      playerActions.seekToMs(targetMs);
      return completed({ position_seconds: seconds(targetMs) });
    }

    case 'player_set_volume': {
      const volume = toNumber(params.volume);
      if (volume === null) {
        return failed('invalid_arguments', 'volume 必须是 0 到 1 之间的数字。');
      }
      const clamped = Math.max(0, Math.min(1, volume));
      playerActions.setVolume(clamped);
      return completed({ volume: Math.round(clamped * 100) / 100 });
    }

    case 'player_get_state':
      return completed(serializeState());

    case 'player_get_queue': {
      const snapshot = getPlayerSnapshot();
      if (snapshot.queueLength === 0) {
        return completed({ total: 0, current_index: -1, offset: 0, items: [] });
      }
      const limit = clampInt(toNumber(params.limit) ?? 20, 1, 50, 20);
      const offset =
        params.offset === undefined || params.offset === null
          ? Math.max(0, snapshot.queueIndex)
          : clampInt(toNumber(params.offset) ?? 0, 0, snapshot.queueLength - 1, 0);
      return completed(serializeQueue(getQueueWindow(offset, limit)));
    }

    case 'track_set_like': {
      const snapshot = getPlayerSnapshot();
      const track = snapshot.track;
      if (!track) {
        return failed('no_track', '当前没有可播放的歌曲。');
      }
      const want = params.liked === undefined ? true : Boolean(params.liked);
      const currently = isTrackLiked(track.hash);
      if (currently === want) {
        return completed({ liked: want, changed: false });
      }
      // toggleLike 未登录/无「我喜欢」歌单时会 reject，由上层统一转成 failed。
      return libraryActions
        .toggleLike(track)
        .then((outcome) => completed({ liked: outcome === 'liked', changed: true }));
    }

    case 'track_get_lyrics': {
      const snapshot = getPlayerSnapshot();
      const track = snapshot.track;
      if (!track) {
        return failed('no_track', '当前没有可播放的歌曲。');
      }
      return resolveLyrics(track)
        .then((lines): ToolResult => {
          if (!lines.length) {
            return failed('no_lyrics', '这首歌没有找到可用歌词。');
          }
          // 用执行时刻的最新进度定位当前句
          const positionMs = getPlayerSnapshot().positionMs;
          const activeIndex = findActiveLyricIndex(lines, positionMs);
          return completed({
            track: { title: track.title, artist: track.artist },
            position_seconds: seconds(positionMs),
            current:
              activeIndex >= 0
                ? {
                    index: activeIndex,
                    time_seconds: seconds(lines[activeIndex].timeMs),
                    text: lines[activeIndex].text,
                  }
                : null,
            lines: lines.map((line, index) => ({
              index,
              time_seconds: seconds(line.timeMs),
              text: line.text,
              current: index === activeIndex,
            })),
          });
        })
        .catch((error: unknown) =>
          failed('lyrics_error', error instanceof Error ? error.message : String(error)),
        );
    }

    case 'music_search_songs': {
      const query = String(params.query ?? '').trim();
      if (!query) {
        return failed('invalid_arguments', 'query 不能为空。');
      }
      const limit = clampInt(toNumber(params.limit) ?? 8, 1, 20, 8);
      return searchSongs(query, 1)
        .then((page): ToolResult => {
          if (!page.tracks.length) {
            return failed('no_results', `没有找到与「${query}」相关的歌曲。`);
          }
          return completed({
            query,
            total: page.total,
            items: page.tracks.slice(0, limit).map((track, index) => ({
              index,
              title: track.title,
              artist: track.artist,
              album: track.album ?? null,
            })),
          });
        })
        .catch((error: unknown) =>
          failed('search_error', error instanceof Error ? error.message : String(error)),
        );
    }

    case 'music_search_playlists': {
      const query = String(params.query ?? '').trim();
      if (!query) {
        return failed('invalid_arguments', 'query 不能为空。');
      }
      const limit = clampInt(toNumber(params.limit) ?? 8, 1, 20, 8);
      return searchPlaylists(query, 1)
        .then((page): ToolResult => {
          if (!page.items.length) {
            return failed('no_results', `没有找到与「${query}」相关的歌单。`);
          }
          return completed({
            query,
            total: page.total,
            items: page.items.slice(0, limit).map((playlist, index) => ({
              index,
              id: playlist.id,
              name: playlist.name,
              creator: playlist.creator,
              song_count: playlist.songCount,
            })),
          });
        })
        .catch((error: unknown) =>
          failed('search_error', error instanceof Error ? error.message : String(error)),
        );
    }

    case 'music_play_songs': {
      const query = String(params.query ?? '').trim();
      if (!query) {
        return failed('invalid_arguments', 'query 不能为空。');
      }
      return searchSongs(query, 1)
        .then(async (page): Promise<ToolResult> => {
          if (!page.tracks.length) {
            return failed('no_results', `没有找到与「${query}」相关的歌曲。`);
          }
          const startIndex = clampInt(toNumber(params.index) ?? 0, 0, page.tracks.length - 1, 0);
          await playCollection({
            tracks: page.tracks,
            startIndex,
            loadedPage: 1,
            hasMore: page.hasMore,
            loadPage: (p) => searchSongs(query, p),
          });
          return completed({ query, started_at_index: startIndex, ...serializeNowPlaying() });
        })
        .catch((error: unknown) =>
          failed('play_error', error instanceof Error ? error.message : String(error)),
        );
    }

    case 'music_play_playlist': {
      const id = params.id != null ? String(params.id).trim() : '';
      const query = params.query != null ? String(params.query).trim() : '';
      if (Boolean(id) === Boolean(query)) {
        return failed('invalid_arguments', '请提供 id 或 query 其中之一。');
      }
      return (async (): Promise<ToolResult> => {
        let playlistId = id;
        let playlistName = '';
        if (!playlistId) {
          const page = await searchPlaylists(query, 1);
          if (!page.items.length) {
            return failed('no_results', `没有找到与「${query}」相关的歌单。`);
          }
          const index = clampInt(toNumber(params.index) ?? 0, 0, page.items.length - 1, 0);
          playlistId = page.items[index].id;
          playlistName = page.items[index].name;
        }

        const first = await fetchPlaylistTracks(playlistId, 1);
        if (!first.tracks.length) {
          return failed('empty_playlist', '这个歌单没有可播放的歌曲。');
        }
        await playCollection({
          tracks: first.tracks,
          startIndex: 0,
          loadedPage: 1,
          hasMore: first.hasMore,
          loadPage: (p) => fetchPlaylistTracks(playlistId, p),
        });
        return completed({
          playlist: { id: playlistId, name: playlistName || first.info?.name || '' },
          track_count: first.info?.count ?? first.tracks.length,
          ...serializeNowPlaying(),
        });
      })().catch((error: unknown) =>
        failed('play_error', error instanceof Error ? error.message : String(error)),
      );
    }

    case 'music_play_daily_recommend': {
      return loadDailyRecommendSongs()
        .then(async (tracks): Promise<ToolResult> => {
          if (!tracks.length) {
            return failed('no_results', '暂时没有获取到每日推荐歌曲。');
          }
          await playerActions.playTracks(tracks, 0);
          return completed({ count: tracks.length, ...serializeNowPlaying() });
        })
        .catch((error: unknown) =>
          failed('play_error', error instanceof Error ? error.message : String(error)),
        );
    }

    default:
      return {
        status: 'unsupported',
        error: { code: 'unknown_tool', message: `未支持的工具: ${name}` },
      };
  }
}
