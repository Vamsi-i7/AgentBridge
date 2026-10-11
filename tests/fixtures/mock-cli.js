#!/usr/bin/env node
// Mock CLI script for testing CliProcessAdapter
const args = process.argv.slice(2);
const mode = args[0] || 'echo';

if (args.includes('--help') || args.includes('-h') || args.includes('--version') || args.includes('-v')) {
  console.log('Mock CLI v1.0.0 (safe test harness)');
  process.exit(0);
}

if (mode === 'pause') {
  const duration = parseInt(args[1] || '2000', 10);
  process.stdout.write('Starting paused task...\n');
  setTimeout(() => {
    process.stdout.write('Finished paused task after ' + duration + 'ms\n');
    console.log(JSON.stringify({ usage: { prompt_tokens: 15, completion_tokens: 25 } }));
    process.exit(0);
  }, duration);
} else if (mode === 'stream') {
  process.stdout.write('Chunk 1: Hello\n');
  setTimeout(() => {
    process.stdout.write('Chunk 2: World\n');
    setTimeout(() => {
      process.stdout.write('Chunk 3: Completed\n');
      console.log(JSON.stringify({ usage: { input_tokens: 20, output_tokens: 40 } }));
      process.exit(0);
    }, 50);
  }, 50);
} else if (mode === 'error') {
  process.stderr.write('Fatal CLI error occurred\n');
  process.exit(1);
} else if (mode === 'stdin') {
  let input = '';
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    process.stdout.write('Processed stdin: ' + input.trim() + '\n');
    console.log(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 10 } }));
    process.exit(0);
  });
} else {
  const prompt = args.join(' ');
  process.stdout.write('CLI Response to: ' + prompt + '\n');
  console.log(JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 18 } }));
  process.exit(0);
}
