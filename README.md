# ocfl-js - An OCFL implementation in Node.js
Node.js library for creating and manipulating Oxford Common File Layout(OCFL) storage and object.
The library consists of common components and implementations for different storage backends.

## Installation

Install the library:

    // For filesystem backend
    npm install @ocfl/ocfl-fs

    // For s3 backend
    npm install @ocfl/ocfl-s3

## Usage

### Storage

Import the corresponding module of the chosen backend and then create a new Storage instance with the right config. For more details, please refer to the documentation of the specific backend implementation. For example:

    // Use filesystem backend
    const ocfl = require('@ocfl/ocfl-fs');
    const storage = ocfl.storage({root: '/var/data/myocfl'});

    // Use S3 backend, assuming the required S3 credentials are set as env vars
    const ocfl = require('@ocfl/ocfl-s3');
    const storage = ocfl.storage({root: '/var/data/myocfl', bucket: "test-bucket"});

Before any OCFL object can be created in the storage, either the `create` or `load` methods must be be called first.
Alternatively, use the `createStorage` and `loadStorage` methods to create a new storage or load an existing storage as follows:
    
    let storage;
    let config = {root: '/var/data/myocfl'};
    try {
      storage = await ocfl.createStorage(config);
    } catch (error) {
      try {
        storage = await ocfl.loadStorage(config);
      } catch (error) {
        console.error('invalid storage root');
      }
    }
    // Do something with the storage here

To choose a different storage layout, pass the layout name, config, or instance:

    // Use class name
    storage = ocfl.createStorage({ root: '/var/data/myocfl', layout: 'FlatDirectStorageLayout' });
    
    // Use official extension name and specify parameters
    storage = ocfl.createStorage({ root: '/var/data/myocfl', layout: { 
      extensionName: '0003-hash-and-id-n-tuple-storage-layout',
      tupleSize: 1
    }});
    
    // Instantiate the class directly
    let layout = new ocfl.StorageLayout.PathDirectStorageLayout({omitScheme: true});
    storage = ocfl.createStorage({ root: '/var/data/myocfl', layout });

Use the `storage` instance to create an object and import files:

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

OCFL objects inside the OCFL storage can be iterated with `for ... of` construct:

    for await (const obj of repo) { 
      console.log(await obj.count())
    }


## Object

The OCFL Object can be instantiated by the storage root as described above. It can also be used directly without
the storage root. For example, if you want to manipulate an ocfl object directory that is not associated with a storage layout.

To create a new object or read an existing object that is not part of any storage:

    const object = ocfl.object({root: '/var/data/myocflobject'})

Add a content to the object from a directory in the local file system. This will create a new version `v1`.

    object.import('/testdata')

Add multiple files from different sources as one transaction. All changes will be saved as one new version `v2`).

    await object.update(async (t)=>{
      t.add()
      t.copy()
    });

List all existing files in the object

    for await (let f of object.files()) {
        // f is the logical path of the file
        let fileContent = await object.getFile(f).asString();
    }

