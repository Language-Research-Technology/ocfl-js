const ERRORS = ["",
  "The OCFL Object Root must not contain files or directories other than those specified in the following sections.",
  "The version declaration must be formatted according to the NAMASTE specification.",
  "[The version declaration] must be a file in the base directory of the OCFL Object Root giving the OCFL version in the filename.",
  "The [version declaration] filename MUST conform to the pattern T=dvalue, where T must be 0, and dvalue must be ocfl_object_, followed by the OCFL specification version number.",
  "The [version declaration] filename must conform to the pattern T=dvalue, where T MUST be 0, and dvalue must be ocfl_object_, followed by the OCFL specification version number.",
  "The [version declaration] filename must conform to the pattern T=dvalue, where T must be 0, and dvalue MUST be ocfl_object_, followed by the OCFL specification version number.",
  "The text contents of the [version declaration] file must be the same as dvalue, followed by a newline (\n).",
  "OCFL Object content must be stored as a sequence of one or more versions.",
  "The version number sequence MUST start at 1 and must be continuous without missing integers.",
  "The version number sequence must start at 1 and MUST be continuous without missing integers.",
  "If zero-padded version directory numbers are used then they must start with the prefix v and then a zero.",
  "All version directories of an object must use the same naming convention: either a non-padded version directory number, or a zero-padded version directory number of consistent length.",
  "Operations that add a new version to an object must follow the version directory naming convention established by earlier versions.",
  "In all cases, references to files inside version directories from inventory files must use the actual version directory names.",
  "There must be no other files as children of a version directory, other than an inventory file and a inventory digest.",
  "Version directories must contain a designated content sub-directory if the version contains files to be preserved, and should not contain this sub-directory otherwise.",
  "The contentDirectory value MUST NOT contain the forward slash (/) path separator and must not be either one or two periods (. or ..).",
  "The contentDirectory value must not contain the forward slash (/) path separator and MUST NOT be either one or two periods (. or ..).",
  "If the key contentDirectory is set, it MUST be set in the first version of the object and must not change between versions of the same object.",
  "If the key contentDirectory is set, it must be set in the first version of the object and MUST NOT change between versions of the same object.",
  "If the key contentDirectory is not present in the inventory file then the name of the designated content sub-directory must be content.",
  "OCFL-compliant tools (including any validators) must ignore all directories in the object version directory except for the designated content directory.",
  "Every file within a version's content directory must be referenced in the manifest section of the inventory.",
  "There must not be empty directories within a version's content directory.",
  "For content-addressing, OCFL Objects must use either sha512 or sha256, and should use sha512.",
  "For storage of additional fixity values, or to support legacy content migration, implementers must choose from the following controlled vocabulary of digest algorithms, or from a list of additional algorithms given in the [Digest-Algorithms-Extension].",
  "OCFL clients must support all fixity algorithms given in the table below, and may support additional algorithms from the extensions.",
  "Optional fixity algorithms that are not supported by a client must be ignored by that client.",
  "SHA-1 algorithm defined by [FIPS-180-4] and must be encoded using hex (base16) encoding [RFC4648].",
  "SHA-256 algorithm defined by [FIPS-180-4] and must be encoded using hex (base16) encoding [RFC4648].",
  "SHA-512 algorithm defined by [FIPS-180-4] and must be encoded using hex (base16) encoding [RFC4648].",
  "[blake2b-512] must be encoded using hex (base16) encoding [RFC4648].",
  "An OCFL Object Inventory MUST follow the [JSON] structure described in this section and must be named inventory.json.",
  "An OCFL Object Inventory must follow the [JSON] structure described in this section and MUST be named inventory.json.",
  "The forward slash (/) path separator must be used in content paths in the manifest and fixity blocks within the inventory.",
  "An OCFL Object Inventory must include the following keys: [id, type, digestAlgorithm, head]",
  "[id] must be unique in the local context, and should be a URI [RFC3986].",
  "In the object root inventory [the type value] must be the URI of the inventory section of the specification version matching the object conformance declaration.",
  "[digestAlgorithm] must be the algorithm used in the manifest and state blocks.",
  "[head] must be the version directory name with the highest version number.",
  "In addition to these keys, there must be two other blocks present, manifest and versions, which are discussed in the next two sections.",
  "Content paths within a manifest block must be relative to the OCFL Object Root.",
  "An OCFL Object Inventory must include a block for storing versions.",
  "This block MUST have the key of versions within the inventory, and it must be a JSON object.",
  "This block must have the key of versions within the inventory, and it MUST be a JSON object.",
  "The keys of [the versions object] must correspond to the names of the version directories used.",
  "Each value [of the versions object] must be another JSON object that characterizes the version, as described in the 3.5.3.1 Version section.",
  "A JSON object to describe one OCFL Version, which must include the following keys: [created, state]",
  "[the value of the “created” key] must be expressed in the Internet Date/Time Format defined by [RFC3339].",
  "The keys of [the “state” JSON object] are digest values, each of which must correspond to an entry in the manifest of the inventory.",
  "The logical path [value of a “state” digest key] must be interpreted as a set of one or more path elements joined by a / path separator.",
  "[logical] Path elements must not be ., .., or empty (//).",
  "Additionally, a logical path must not begin or end with a forward slash (/).",
  "The value of the user key must contain a user name key, “name” and should contain an address key, “address”.",
  "This block must have the key of fixity within the inventory.",
  "The fixity block must contain keys corresponding to the controlled vocabulary given in the digest algorithms listed in the Digests section, or in a table given in an Extension.",
  "The value of the fixity block for a particular digest algorithm must follow the structure of the manifest block; that is, a key corresponding to the digest value, and an array of content paths that match that digest.",
  "Every occurrence of an inventory file must have an accompanying sidecar file stating its digest.",
  "This value must match the value given for the digestAlgorithm key in the inventory.",
  "The digest sidecar file must contain the digest of the inventory file.",
  "[The digest sidecar file] must follow the format: DIGEST inventory.json",
  "The digest of the inventory must be computed only after all changes to the inventory have been made, and thus writing the digest sidecar file is the last step in the versioning process.",
  "Every OCFL Object must have an inventory file within the OCFL Object Root, corresponding to the state of the OCFL Object at the current version.",
  "Where an OCFL Object contains inventory.json in version directories, the inventory file in the OCFL Object Root must be the same as the file in the most recent version.",
  "Each version block in each prior inventory file must represent the same object state as the corresponding version block in the current inventory file.",
  "The extensions directory must not contain any files, and no sub-directories other than extension sub-directories.",
  "The specific structure and function of the extension, as well as a declaration of the registered extension name must be defined in one of the following locations: The OCFL Extensions repository OR The Storage Root, as a plain text document directly in the Storage Root.",
  "An OCFL Storage Root MUST contain a Root Conformance Declaration identifying it as such.",
  "If present, [the ocfl_layout.json document] MUST include the following two keys in the root JSON object: [key, description]",
  "The value of the [ocfl_layout.json] extension key must be the registered extension name for the extension defining the arrangement under the storage root.",
  "The directory hierarchy used to store OCFL Objects MUST NOT contain files that are not part of an OCFL Object.",
  "Empty directories MUST NOT appear under a storage root.",
  "Although implementations may require multiple OCFL Storage Roots - that is, several logical or physical volumes, or multiple “buckets” in an object store - each OCFL Storage Root MUST be independent.",
  "The OCFL version declaration MUST be formatted according to the NAMASTE specification.",
  "[The OCFL version declaration] MUST be a file in the base directory of the OCFL Storage Root giving the OCFL version in the filename.",
  "[The OCFL version declaration filename] MUST conform to the pattern T=dvalue, where T must be 0, and dvalue must be ocfl_, followed by the OCFL specification version number.",
  "[The OCFL version declaration filename] must conform to the pattern T=dvalue, where T MUST be 0, and dvalue must be ocfl_, followed by the OCFL specification version number.",
  "[The OCFL version declaration filename] must conform to the pattern T=dvalue, where T must be 0, and dvalue MUST be ocfl_, followed by the OCFL specification version number.",
  "The text contents of [the OCFL version declaration file] MUST be the same as dvalue, followed by a newline (\n).",
  "OCFL Objects within the OCFL Storage Root also include a conformance declaration which MUST indicate OCFL Object conformance to the same or earlier version of the specification.",
  "OCFL Object Roots MUST be stored either as the terminal resource at the end of a directory storage hierarchy or as direct children of a containing OCFL Storage Root.",
  "There MUST be a deterministic mapping from an object identifier to a unique storage path.",
  "Storage hierarchies MUST NOT include files within intermediate directories.",
  "Storage hierarchies MUST be terminated by OCFL Object Roots.",
  "The storage root extensions directory MUST conform to the same guidelines and limitations as those defined for object extensions.",
  "An OCFL validator MUST ignore any files in the storage root it does not understand.",
  "An OCFL Storage Root MUST NOT contain directories or sub-directories other than as a directory hierarchy used to store OCFL Objects or for storage root extensions.",
  "If the preservation of non-OCFL-compliant features is required then the content MUST be wrapped in a suitable disk or filesystem image format which OCFL can treat as a regular file.",
  "Hard and soft (symbolic) links are not portable and MUST NOT be used within OCFL Storage hierachies.",
  "Filesystems MUST preserve the case of OCFL filepaths and filenames.",
  "The value for each key in the manifest must be an array containing the content paths of files in the OCFL Object that have content with the given digest.",
  "Where included in the fixity block, the digest values given must match the digests of the files at the corresponding content paths.",
  "The value of [the message] key is freeform text, used to record the rationale for creating this version. It must be a JSON string.",
  "Within a version, logical paths must be unique and non-conflicting, so the logical path for a file cannot appear as the initial part of another logical path.",
  "As JSON keys are case sensitive, while digests may not be, there is an additional requirement that each digest value must occur only once in the manifest regardless of case.",
  "As JSON keys are case sensitive, while digests may not be, there is an additional requirement that each digest value must occur only once in the fixity block for any digest algorithm, regardless of case.",
  "The content path must be interpreted as a set of one or more path elements joined by a / path separator.",
  "[content] path elements must not be ., .., or empty (//).",
  "A content path must not begin or end with a forward slash (/).",
  "Within an inventory, content paths must be unique and non-conflicting, so the content path for a file cannot appear as the initial part of another content path.",
  "An inventory file must not contain keys that are not specified."
];

const WARNINGS = [
  "Implementations SHOULD use version directory names constructed without zero-padding the version number, ie. v1, v2, v3, etc.'",
  "The version directory SHOULD NOT contain any directories other than the designated content sub-directory. Once created, the contents of a version directory are expected to be immutable.",
  "Version directories must contain a designated content sub-directory if the version contains files to be preserved, and SHOULD NOT contain this sub-directory otherwise.",
  "For content-addressing, OCFL Objects SHOULD use sha512.",
  "The OCFL Object Inventory id SHOULD be a URI.",
  "In the OCFL Object Inventory, the JSON object describing an OCFL Version, SHOULD include the message and user keys.",
  "In the OCFL Object Inventory, in the version block, the value of the user key SHOULD contain an address key, address.",
  "In the OCFL Object Inventory, in the version block, the address value SHOULD be a URI: either a mailto URI [RFC6068] with the e-mail address of the user or a URL to a personal identifier, e.g., an ORCID iD.",
  "In addition to the inventory in the OCFL Object Root, every version directory SHOULD include an inventory file that is an Inventory of all content for versions up to and including that particular version.",
  "In the case that prior version directories include an inventory file, the values of the created, message and user keys in each version block in each prior inventory file SHOULD have the same values as the corresponding keys in the corresponding version block in the current inventory file.",
  "Implementers SHOULD use the logs directory, if present, for storing files that contain a record of actions taken on the object.",
  "In an OCFL Object, extension sub-directories SHOULD be named according to a registered extension name.",
  "Storage hierarchies within the same OCFL Storage Root SHOULD use just one layout pattern.",
  "Storage hierarchies within the same OCFL Storage Root SHOULD consistently use either a directory hierarchy of OCFL Objects or top-level OCFL Objects."
];

class ValidationError extends Error {
  constructor(options = {}) {
    super(`${options.code}: ${options.description} At ${options.path}`);
    this.name = 'ValidationError';
    Object.assign(this, options);
  }
}

function getError(id) {
  return genValObj(ERRORS, id);
}
function getWarning(id) {
  return genValObj(WARNINGS, id);
}

function genValObj(arr, id) {
  return {
    code: 'E' + ('' + id).padStart(3, '0'),
    description: arr[id - 1]
  };
}

//console.log(getError(2));
//throw new ValidationError({...getError(1),path:'/test'});
exports.Error = ValidationError;
exports.getError = getError;
exports.getWarning = getWarning;
exports.createError = function (id, path) {
  return new ValidationError({ ...getError(id), path });
}

class Validator {
  /**
   * From the spec: the contentDirectory value must not contain the forward slash (/) path separator 
   * and must not be either one or two periods (. or ..)
   * @param {string} name 
   */
  validateContentDirectoryName(name) {
    // if (name === '.' || name === '..' || name.includes('/')) {
    //   throw new validation.Error('contentDirectory is invalid'); 16, 17
    // }
  }
  /**
   * If the key contentDirectory is set, it must be set in the first version of the object and must not change between versions of the same object.
   * Every file within a version's content directory must be referenced in the manifest section of that version's inventory. There must not be empty directories within a version's content directory. 
   */
  validateContentDirectory() {
  }
  validateInventory(inventory) {
    new URL(inventory.id);
  }

}
