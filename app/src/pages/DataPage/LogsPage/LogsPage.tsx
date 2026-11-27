import { useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { baseURL } from '@api/api';
import {
  Paper, Typography, Box, MenuItem, Select, FormControl, FormHelperText, InputLabel,
  Alert, Button, Menu, TextField, IconButton, Tooltip, Chip,
} from '@mui/material';
import { palette, radius } from '@design/tokens';
import axios from '@api/api';
import { SubpageShell } from '../Header.tsx';
import DownloadIcon from '@mui/icons-material/Download';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import PauseIcon from '@mui/icons-material/Pause';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { getLogDescription, detectLogLevel } from './logsMeta.ts';
import { appendCapped } from './logsBuffer.ts';


const LEVEL_COLORS: Record<string, string> = {
  error: palette.status.error,
  warn: palette.status.warn,
  debug: palette.text.tertiary,
  info: palette.text.primary,
};

export default function LogsPage() {
  const [searchParams] = useSearchParams();
  const requestedFile = searchParams.get('file');
  const appliedFileQuery = useRef<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [pendingLogs, setPendingLogs] = useState<string[]>([]);
  const [logFiles, setLogFiles] = useState<string[]>([]);
  const [selectedLog, setSelectedLog] = useState<string>('');
  const [filterText, setFilterText] = useState('');
  const [paused, setPaused] = useState(false);
  const [connection, setConnection] = useState<'waiting' | 'connecting' | 'live' | 'disconnected'>('waiting');
  const [listError, setListError] = useState(false);
  const [filesLoaded, setFilesLoaded] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [severity, setSeverity] = useState('all');
  const [actionsAnchor, setActionsAnchor] = useState<HTMLElement | null>(null);
  const logsContainerRef = useRef<HTMLDivElement | null>(null);
  const logsEndRef = useRef<HTMLDivElement | null>(null);
  const isUserAtBottom = useRef(true);
  // The SSE subscription effect only re-runs when selectedLog changes, so its
  // onmessage closure would otherwise see a stale `paused` from subscribe
  // time, so read the live value through a ref instead.
  const pausedRef = useRef(false);

  // Fetch available log files.
  useEffect(() => {
    const controller = new AbortController();
    const fetchLogFiles = async () => {
      setListError(false);
      try {
        const response = await axios.get<{ logs: string[] }>('/logs', { signal: controller.signal });
        setLogFiles(response.data.logs);
        const queryChanged = appliedFileQuery.current !== requestedFile;
        if (queryChanged) {
          setLogs([]);
          setPendingLogs([]);
        }
        setSelectedLog(previous => {
          if (!queryChanged && response.data.logs.includes(previous)) return previous;
          if (requestedFile && response.data.logs.includes(requestedFile)) return requestedFile;
          return response.data.logs[0] ?? '';
        });
        appliedFileQuery.current = requestedFile;
      } catch {
        if (!controller.signal.aborted) setListError(true);
      } finally {
        if (!controller.signal.aborted) setFilesLoaded(true);
      }
    };

    void fetchLogFiles();
    return () => controller.abort();
  }, [reconnectAttempt, requestedFile]);

  // Subscribe to log updates for the selected file
  useEffect(() => {
    if (!selectedLog) return;

    if (typeof EventSource === 'undefined') return;
    let active = true;
    setConnection('connecting');
    const eventSource = new EventSource(`${baseURL}/api/logs/${encodeURIComponent(selectedLog)}`);
    eventSource.onopen = () => {
      if (!active) return;
      // Each connection starts with a fresh tail from the server.
      setLogs([]);
      setPendingLogs([]);
      setConnection('live');
    };

    eventSource.onmessage = (event) => {
      if (!active) return;
      let message: unknown;
      if (typeof event.data !== 'string') return;
      try { message = JSON.parse(event.data).message; } catch { return; }
      if (typeof message !== 'string') return;
      const newLines = message.split('\n');
      if (pausedRef.current) {
        // Capped the same way as `logs` below: otherwise a busy log file
        // left streaming while paused grows this array without bound.
        setPendingLogs((prev) => appendCapped(prev, newLines));
      } else {
        setLogs((prevLogs) => appendCapped(prevLogs, newLines));
      }
    };

    eventSource.onerror = () => {
      // Keep the source open: the browser retries lost SSE connections.
      if (active) setConnection('disconnected');
    };

    return () => {
      active = false;
      eventSource.close();
    };
  }, [selectedLog, reconnectAttempt]); // Re-run when the log file changes; pause state is read live via pausedRef

  // Track if user is at the bottom
  const handleScroll = () => {
    if (!logsContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
    isUserAtBottom.current = scrollHeight - scrollTop <= clientHeight + 50; // 50px buffer
  };

  // Auto-scroll only if user is at the bottom
  useEffect(() => {
    if (isUserAtBottom.current) {
      logsEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [logs]);

  const handleTogglePause = () => {
    if (paused) {
      // Resuming, so flush anything buffered while paused.
      setLogs((prevLogs) => appendCapped(prevLogs, pendingLogs));
      setPendingLogs([]);
    }
    pausedRef.current = !paused;
    setPaused((p) => !p);
  };

  const handleClear = () => {
    setLogs([]);
    setPendingLogs([]);
  };

  const handleDownload = () => {
    const blob = new Blob([logs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = selectedLog || 'log.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const filteredLogs = useMemo(() => {
    const needle = filterText.toLowerCase();
    return logs.filter(line => line.toLowerCase().includes(needle) && (severity === 'all' || detectLogLevel(line) === severity));
  }, [logs, filterText, severity]);

  return (
    <SubpageShell title="Logs" backTo="/settings/device" backLabel="Back to Pod and diagnostics">
      { requestedFile && filesLoaded && !listError && !logFiles.includes(requestedFile) && (
        <Alert severity="info">The requested log is unavailable. Choose from the listed files.</Alert>
      ) }
      { listError && (
        <Alert severity="error" action={ <Button onClick={ () => setReconnectAttempt(value => value + 1) }>Retry</Button> }>
          Could not load log files.
        </Alert>
      ) }
      { connection === 'disconnected' && (
        <Alert severity="warning" action={ <Button onClick={ () => setReconnectAttempt(value => value + 1) }>Reconnect</Button> }>
          Disconnected, reconnecting automatically. Displayed lines may be incomplete.
        </Alert>
      ) }

      <Paper
        sx={ {
          p: 2,
          bgcolor: palette.bg.elevated,
          borderRadius: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
        } }
      >
        <Box sx={ { display: 'flex', gap: 2, flexDirection: 'column', mb: 2 } }>
          <FormControl size="small" sx={ { minWidth: 0, width: '100%' } }>
            <InputLabel id="log-file-label" sx={ { color: palette.text.primary } }>Log file</InputLabel>
            <Select
              labelId="log-file-label"
              label="Log file"
              value={ selectedLog }
              onChange={ (e) => {
                setLogs([]);
                setPendingLogs([]);
                setSelectedLog(e.target.value);
              } }
            >
              { logFiles.map((file) => (
                <MenuItem key={ file } value={ file }>
                  { file }
                </MenuItem>
              )) }
            </Select>
            { selectedLog && <FormHelperText>{ getLogDescription(selectedLog) }</FormHelperText> }
          </FormControl>

          <TextField
            size="small"
            label="Search loaded lines"
            value={ filterText }
            onChange={ (e) => setFilterText(e.target.value) }
            sx={ { minWidth: 0, width: '100%' } }
          />

          <Box sx={ { display: 'flex', width: '100%', alignItems: 'flex-end', gap: 1 } }>
            <FormControl size="small" sx={ { minWidth: 0, flex: 1, my: 0 } }>
              <InputLabel id="log-level-label">Severity</InputLabel>
              <Select labelId="log-level-label" label="Severity" value={ severity } onChange={ event => setSeverity(event.target.value) }>
                { Object.entries({ all: 'All levels', error: 'Errors', warn: 'Warnings', info: 'Info', debug: 'Debug' })
                  .map(([level, label]) => <MenuItem key={ level } value={ level }>{ label }</MenuItem>) }
              </Select>
            </FormControl>
            <Box sx={ { display: 'flex', gap: 0.5 } }>
              <Tooltip title={ paused ? `Resume (${pendingLogs.length} new)` : 'Pause live updates' }>
                <IconButton
                  aria-label={ paused ? 'Resume live updates' : 'Pause live updates' }
                  onClick={ handleTogglePause }
                  size="small"
                  sx={ { color: palette.text.primary } }
                >
                  { paused ? <PlayArrowIcon /> : <PauseIcon /> }
                </IconButton>
              </Tooltip>
              <Tooltip title="Loaded line actions">
                <IconButton aria-label="Loaded line actions" onClick={ event => setActionsAnchor(event.currentTarget) } size="small">
                  <MoreVertIcon/>
                </IconButton>
              </Tooltip>
              <Menu
                anchorEl={ actionsAnchor }
                open={ !!actionsAnchor }
                onClose={ () => setActionsAnchor(null) }
                anchorOrigin={ { vertical: 'bottom', horizontal: 'right' } }
                transformOrigin={ { vertical: 'top', horizontal: 'right' } }>
                <MenuItem onClick={ () => { handleDownload(); setActionsAnchor(null); } } disabled={ logs.length === 0 }>
                  <DownloadIcon sx={ { mr: 1 } }/>Download loaded lines
                </MenuItem>
                <MenuItem onClick={ () => { handleClear(); setActionsAnchor(null); } }>
                  <ClearAllIcon sx={ { mr: 1 } }/>Clear displayed lines
                </MenuItem>
              </Menu>
            </Box>
          </Box>
        </Box>

        { (paused || connection !== 'live') && <Chip
          size="small"
          sx={ { alignSelf: 'flex-start', mb: 1 } }
          label={ paused ? 'Paused' : connection === 'disconnected' ? 'Disconnected' : connection === 'connecting' ? 'Connecting' : 'Waiting' }
        /> }

        { paused && pendingLogs.length > 0 && (
          <Button onClick={ handleTogglePause } sx={ { ml: -1, mb: 1, alignSelf: 'flex-start' } }>
            { `Show ${pendingLogs.length} new line${pendingLogs.length === 1 ? '' : 's'}` }
          </Button>
        ) }

        { (filterText || severity !== 'all') && <Typography variant="body2" sx={ { pb: 1, borderBottom: 1, borderColor: 'divider' } }>
          Filtered lines ({ filteredLogs.length }/{ logs.length })
        </Typography> }

        <Box
          ref={ logsContainerRef }
          onScroll={ handleScroll }
          sx={ {
            flex: 1,
            overflowY: 'auto',
            maxHeight: `${window.innerHeight - 340}px`,
            fontFamily: 'monospace',
            pr: 1,
            '&::-webkit-scrollbar': {
              width: '10px',
            },
            '&::-webkit-scrollbar-track': {
              background: palette.bg.elevated,
              borderRadius: `${radius.mark}px`,
            },
            '&::-webkit-scrollbar-thumb': {
              background: palette.border.control,
              borderRadius: `${radius.mark}px`,
            },
            '&::-webkit-scrollbar-thumb:hover': {
              background: palette.text.tertiary,
            },
          } }
        >
          { filteredLogs.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              { logs.length > 0 ? 'No matching lines.' : paused ? 'Paused. Resume to show incoming lines.'
                : filesLoaded && logFiles.length === 0 && !listError ? 'No log files available.'
                  : connection === 'disconnected' ? 'Waiting to reconnect.' : 'Waiting for log lines.' }
            </Typography>
          ) }
          { filteredLogs.map((line, i) => {
            const level = detectLogLevel(line);
            return (
              <Typography
                key={ i }
                component="div"
                sx={ {
                  fontFamily: 'monospace',
                  color: level ? LEVEL_COLORS[level] : palette.text.primary,
                  fontSize: '12px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                } }
              >
                { line }
              </Typography>
            );
          }) }
          <div ref={ logsEndRef } />
        </Box>
      </Paper>
    </SubpageShell>
  );
}
