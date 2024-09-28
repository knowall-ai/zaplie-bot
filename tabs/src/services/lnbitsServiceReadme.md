## Symbolic Link

This is a symbolic link to the `lnbitsServices.ts` in the parent project.

## Link creation

This should be automatically created when you run `npm install` since we have added:

```
  "scripts": {
    "postinstall": "node create-symlink.js"
  },
```

Create a new `create-symlink.js`

```
const fs = require('fs');
const path = require('path');

const target = path.resolve(__dirname, '../src/components/lnbitsService.ts'); // Correct target path
const link = path.resolve(__dirname, './src/services/lnbitsService.ts'); // Correct link path

fs.symlink(target, link, 'file', (err) => {
  if (err) {
    console.error('Error creating symbolic link:', err);
  } else {
    console.log('Symbolic link created successfully');
    console.log(`Link path: ${link}`);
    console.log(`Target path: ${target}`);
  }
});
```
