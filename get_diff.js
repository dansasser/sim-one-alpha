import fs from 'fs';
import { execSync } from 'child_process';

const diff = execSync('git diff main').toString();
fs.writeFileSync('my_diff.txt', diff);
