# ocfl-js - An OCFL implementation in Node.js
Node.js library for creating and manipulating Oxford Common File Layout(OCFL) storage and object.
The library consists of common components and implementations for different storage backend.

# Usage
## Storage
### Creating storage

Import the corresponding module of the chosen backend and then 
create a new Storage instance with the right config, for example:

#### Filesystem backend

    const ocfl = require('ocfl-fs');
    const storage = ocfl.storage({root: '/var/data/myocfl'});

#### S3 backend

    const ocfl = require('ocfl-s3');
    const storage = ocfl.storage({
      root: '/myocfl'
      bucket: "test-bucket3",
      accessKeyId: "minio",
      secretAccessKey: "minio_pass",
      endpoint: "http://localhost:9000",
    });

### Creating or load a new repository
    
    // Check if path is a repository
    if (await storage.exists()) {
      // Load an existing repository
      await storage.load();
    } else {
      // Create a new repository
      await storage.create();
    }

### Create an object and import files

    if (await storage.load()) {
        let o = storage.object('test-object');

        // import from one directory
        await o.import('/var/data/dir1');

        // import from multiple directories
        await o.import(['/var/data/dir2', '/var/data/dir3', '/var/data/dir4']);

        // import from multiple files and directories to specific logical paths
        // use an array of [source, target] where source is the path to source file or directory
        // and target is the logical path of the file in the object. 
        // To put files under a source directory in the root of object, set target to empty string ('')
        await o.import([
          ['/var/data/file1', 'test1/file1'],
          ['/var/data2/file1', 'test2/file1'],
          ['/var/data2/dir1', 'test2/dir1'],
          ['/var/data2/dir2', '']
        ]);
    } 


## Object
The OCFL Object class can be used with the storage root as described above. It can also be used directly without
the storage root. For example, if you want to manipulate an an ocfl object directory that is not associated with a storage layout.

Create a new object

    let object = new Object({path:})

Add a content to the object from a directory in the local file system. This will create a new version `v1`.

    object.import('/testdata')

Add multiple files from different sources as one transaction. All changes will be saved as one new version `v2`).

    await object.update(async (t)=>{
      t.add()
      t.copy()
    });

Accessing existing object

    let object = new Object({path:'', id:''})

List all existing files in the object

    for await (let f of object.files()) {
        // f is the logical path of the file
        let fileContent = object.get(f);
    }

Modify existing object

    object.add();
