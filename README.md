# ocfl-js - An OCFL implementation in Node.js
Node.js library for creating and manipulating Oxford Common File Layout(OCFL) storage and object
This is JavaScript/Node.js library to create and interact with Oxford Common File Layout (OCFL) storage and objects within it. The library consists of common components and implementations for different storage backend.

# Usage
## Storage
### Creating storage

Import the corresponding module of the chosen backend and then 
create a new Storage instance with the right config, for example:

#### Filesystem backend

    const ocfl = require('ocfl-fs');
    const storage = new ocfl.Storage({root: '/var/data/myocfl'});

#### S3 backend

    const ocfl = require('ocfl-s3');
    const storage = new ocfl.Storage({
      root: '/myocfl'
      bucket: "test-bucket3",
      accessKeyId: "minio",
      secretAccessKey: "minio_pass",
      endpoint: "http://localhost:9000",
    });

### Creating a new repository
    // create it
    await storage.create();

### Open an existing repository
    // create it
    let storage = await ocfl.Storage.create();

### Check if path is a repository

    // check for namaste file and return true or false
    await storage.exist()


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
