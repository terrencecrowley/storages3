// Node libraries
import * as fs from 'fs';
import * as stream from 'stream';
import * as zlib from 'zlib';

// Public libraries
import * as AWS from 'aws-sdk';

// Shared libraries
import * as Context from '@dra2020/context';
import * as Storage from '@dra2020/storage';
import * as LogAbstract from '@dra2020/logabstract';
import * as FSM from '@dra2020/fsm';

export interface Environment
{
  context: Context.IContext;
  log: LogAbstract.ILog;
  fsmManager: FSM.FsmManager;
  storageManager: Storage.StorageManager;
}

class S3Request implements Storage.BlobRequest
{
  blob: Storage.StorageBlob;
  req: any;
  res: any;
  data: any;
  err: any;

  constructor(blob: Storage.StorageBlob)
  {
    this.blob = blob;
    this.req = null;
    this.res = null;
    this.data = null;
    this.err = null;
  }

  continuationToken(): string
  {
    if (this.data && this.data.NextContinuationToken)
      return this.data.NextContinuationToken;

    return undefined;
  }

  result(): number
  {
    if (this.data == null && this.blob.asLoadStream() == null && this.err == null)
      return Storage.EPending;
    else if (this.err != null)
    {
      if (this.err.statusCode && this.err.statusCode == 404)
        return Storage.ENotFound;
      else
        return Storage.EFail;
    }
    else
      return Storage.ESuccess;
  }

  asString(): string
  {
    if (this.err || this.res == null || this.data == null || this.data.Body == null)
      return undefined;
    let body: Buffer;
    if (this.data.ContentEncoding && this.data.ContentEncoding === 'gzip')
      body = zlib.gunzipSync(this.data.Body);
    else
      body = this.data.Body;
    return body.toString('utf-8');
  }

  // Really probably should be reverse semantics - you need to explicitly ask for the unprocessed buffer
  asUncompressedBuffer(): Buffer
  {
    if (this.err || this.res == null || this.data == null || this.data.Body == null)
      return undefined;
    let body: Buffer;
    if (this.data.ContentEncoding && this.data.ContentEncoding === 'gzip')
      body = zlib.gunzipSync(this.data.Body);
    else
      body = this.data.Body;
    return body;
  }

  asBuffer(): Buffer
  {
    if (this.err || this.res == null || this.data == null || this.data.Body == null)
      return undefined;
    return this.data.Body;
  }

  asArray(): string[]
  {
    let a: string[] = [];

    if (this.data && Array.isArray(this.data.Contents))
      for (let i: number = 0; i < this.data.Contents.length; i++)
        a.push(this.data.Contents[i].Key ? this.data.Contents[i].Key : '');

    return a;
  }

  _dataToProps(data: any): Storage.BlobProperties
  {
    let props: Storage.BlobProperties = {};
    props.ContentLength = (data.Size !== undefined) ? data.Size : 0;
    props.Key = data.Key;
    props.ETag = data.ETag;
    props.LastModified = data.LastModified;
    props.ContentEncoding = data.ContentEncoding;
    return props;
  }

  asProps(): Storage.BlobProperties[]
  {
    let a: Storage.BlobProperties[] = [];

    if (this.data && Array.isArray(this.data.Contents))
    {
      for (let i: number = 0; i < this.data.Contents.length; i++)
        a.push(this._dataToProps(this.data.Contents[i]));
    }
    else
      a.push(this._dataToProps(this.data));

    return a;
  }

  asError(): string
  {
      if (this.err)
        return this.err.message ? this.err.message : JSON.stringify(this.err);
      return undefined;
  }
}

const ChunkSize = 4000000;

export class FsmStreamLoader extends FSM.Fsm
{
  sm: StorageManager;
  blob: Storage.StorageBlob;
  param: any;
  err: any;
  contentLength: number;
  contentPos: number;
  readStream: Storage.MultiBufferPassThrough;
  passThrough: Storage.MultiBufferPassThrough;

  constructor(env: Environment, sm: StorageManager, blob: Storage.StorageBlob)
  {
    super(env);
    this.sm = sm;
    this.blob = blob;
    this.contentPos = 0;
    this.param = { Bucket: sm.blobBucket(blob), Key: blob.id };

    // We use passthrough stream because we want to make the load stream available
    // immediately but we don't actually know whether we are going to have to pipe
    // through gunzip or not until we get the first ContentEncoding header back.
    this.readStream = new Storage.MultiBufferPassThrough();
    this.passThrough = new Storage.MultiBufferPassThrough();
    this.blob.setLoadStream(this.passThrough);
  }

  get env(): Environment { return this._env as Environment; }

  tick(): void
  {
    if (this.ready)
    {
      // Figure out next chunk
      if (this.contentLength === undefined)
        this.param.Range = `bytes=0-${ChunkSize-1}`;
      else
        this.param.Range = `bytes=${this.contentPos}-${Math.min(this.contentPos+ChunkSize-1, this.contentLength-1)}`;

      switch (this.state)
      {

        case FSM.FSM_STARTING:
          this.sm.s3.getObject(this.param, (err: any, data: any) => {
              if (err == null)
              {
                // On first chunk, figure out if we need to pipe through gunzip
                if (this.contentLength === undefined)
                {
                  if (data.ContentEncoding && data.ContentEncoding === 'gzip')
                  {
                    let unzip = zlib.createGunzip({});
                    unzip.on('end', () => { this.passThrough._done(); this.setState(FSM.FSM_DONE); } );
                    unzip.on('error', () => { this.passThrough._done(); this.setState(FSM.FSM_ERROR); } );
                    this.readStream.pipe(unzip).pipe(this.passThrough);
                  }
                  else
                  {
                    this.readStream.on('end', () => { this.passThrough._done(); this.setState(FSM.FSM_DONE); } );
                    this.readStream.on('error', () => { this.passThrough._done(); this.setState(FSM.FSM_ERROR); } );
                    this.readStream.pipe(this.passThrough);
                  }
                }

                // Handle this data
                if (data.Body)
                  this.readStream.write(data.Body);

                // Update content range and content length for next time through, or noticing finish
                if (data.ContentRange)
                {
                  let re = /bytes (\d+)-(\d+)\/(\d+)/
                  let s: string = data.ContentRange;  // "bytes start-end/total"
                  let matched = re.exec(s);
                  if (matched && matched.length === 4)
                  {
                    this.contentPos = Number(matched[2]) + 1;
                    this.contentLength = Number(matched[3]);
                  }
                }
              }

              // Error or done reading
              if (err || this.contentPos === this.contentLength)
              {
                this.err = err;
                this.readStream._done();
                if (err)
                {
                  this.passThrough._done();
                  this.setState(FSM.FSM_ERROR);
                }
              }
              else
                this.setState(FSM.FSM_STARTING);
            });
          break;
      }
    }
  }
}

export class FsmTransferUrl extends Storage.FsmTransferUrl
{
  storageManager: StorageManager;

  constructor(env: Environment, bucket: string, params: Storage.TransferParams)
  {
    super(env, bucket, params);
  }
}

export class StorageManager extends Storage.StorageManager
{
  s3: any;
  count: number;

  constructor(env: Environment, bucketMap?: Storage.BucketMap)
  {
    super(env, bucketMap);

    if (this.env.context.xstring('aws_access_key_id') === undefined
        || this.env.context.xstring('aws_secret_access_key') === undefined)
    {
      this.env.log.error('S3: not configured: exiting');
      this.env.log.dump();
      process.exit(1);
    }

    AWS.config.update({region: 'us-west-2'});
    this.s3 = new AWS.S3({apiVersion: '2006-03-01'});
    this.count = 0;
  }

  get env(): Environment { return this._env as Environment; }

  lookupBucket(s: string): string
  {
    while (this.bucketMap[s] !== undefined)
      s = this.bucketMap[s];
    return s;
  }

  blobBucket(blob: Storage.StorageBlob): string
  {
    return this.lookupBucket(blob.bucketName);
  }

  load(blob: Storage.StorageBlob): void
  {
    if (blob.id == '')
    {
      this.env.log.error('S3: blob load called with empty key');
      return;
    }
    let id: string = `load+${blob.id}+${this.count++}`;

    this.env.log.event('S3: load start', 1);
    let trace = new LogAbstract.AsyncTimer(this.env.log, 'S3: load', 1);
    let params = { Bucket: this.blobBucket(blob), Key: blob.id };
    let rq = new S3Request(blob);
    this.loadBlobIndex[id] = rq;
    blob.setLoading();
    if (blob.param('ContentDisposition') === 'stream')
    {
      let fsm = new FsmStreamLoader(this.env, this, blob);
      rq.req = fsm;
      new FSM.FsmOnDone(this.env, fsm, (f: FSM.Fsm) => {
          this._finishLoad(blob, id, rq, fsm.err, undefined);
          trace.log();
        });
    }
    else
    {
      rq.req = this.s3.getObject(params, (err: any, data: any) => {
          this._finishLoad(blob, id, rq, err, data);
          trace.log();
        });
    }
  }

  _finishLoad(blob: Storage.StorageBlob, id: string, rq: S3Request, err: any, data: any)
  {
    rq.res = this;
    if (err)
      rq.err = err;
    else
      rq.data = data;

    blob.setLoaded(rq.result());
    blob.endLoad(rq);
    this.emit('load', blob);

    delete this.loadBlobIndex[id];

    this.env.log.event('S3: load end', 1);
  }

  head(blob: Storage.StorageBlob): void
  {
    if (blob.id == '')
    {
      this.env.log.error('S3: blob head called with empty key');
      return;
    }
    let id: string = `head+${blob.id}+${this.count++}`;

    this.env.log.event('S3: head start', 1);
    let trace = new LogAbstract.AsyncTimer(this.env.log, 'S3: head', 1);
    let params = { Bucket: this.blobBucket(blob), Key: blob.id };
    let rq = new S3Request(blob);
    this.headBlobIndex[id] = rq;
    blob.setLoading();
    rq.req = this.s3.headObject(params, (err: any, data: any) => {
        rq.res = this;
        if (err)
          rq.err = err;
        else
          rq.data = data;

        blob.setLoaded(rq.result());
        blob.endHead(rq);
        this.emit('head', blob);

        delete this.headBlobIndex[id];

        this.env.log.event('S3: head end', 1);
        trace.log();
      });
  }

  save(blob: Storage.StorageBlob): void
  {
    if (blob.id == '')
    {
      this.env.log.error('S3: blob save called with empty key');
      return;
    }
    let id: string = `save+${blob.id}+${this.count++}`;

    this.env.log.event('S3: save start', 1);

    let trace = new LogAbstract.AsyncTimer(this.env.log, 'S3: save', 1);
    let params: any = { Bucket: this.blobBucket(blob), Key: blob.id };
    if (blob.param('ContentEncoding'))
      params['ContentEncoding'] = blob.param('ContentEncoding');
    if (blob.param('ContentType'))
      params['ContentType'] = blob.param('ContentType');
    if (blob.param('CacheControl'))
      params['CacheControl'] = blob.param('CacheControl');
    let rq = new S3Request(blob);
    this.saveBlobIndex[id] = rq;
    blob.setSaving();

    // Get contents, try in order: 1) stream, 2) local file, 3) buffer, 4) utf8 string
    let blobStream = blob.asStream();
    if (blobStream == null && blob.param('ContentEncoding') !== 'gzip') // For gzip, need a buffer to compute length for save
    {
      let path: string = blob.asFile();
      if (path)
      {
        try
        {
          blobStream = fs.createReadStream(path);
        }
        catch (err)
        {
          rq.err = err;
          process.nextTick(() => {
              blob.setSaved(rq.result());
              blob.endSave(rq);
              this.emit('save', blob);
              delete this.saveBlobIndex[id];
              this.env.log.error('S3: failed to open blob path file');
              trace.log();
            });
          return;
        }
      }
    }

    if (blobStream != null)
      params.Body = blobStream;
    else
    {
      let b = blob.asBuffer();
      params.Body = b ? b : blob.asString();
    }

    rq.req = this.s3.putObject(params, (err: any, data: any) => {
        if (err)
          rq.err = err;
        else
          rq.data = data;
        rq.res = this;

        blob.setSaved(rq.result());
        blob.endSave(rq);
        this.emit('save', blob);

        delete this.saveBlobIndex[id];

        this.env.log.event('S3: save done', 1);
        trace.log();

        if (blobStream)
          blobStream.destroy();
      });
  }

  del(blob: Storage.StorageBlob): void
  {
    if (blob.id == '')
    {
      this.env.log.error('S3: blob delete called with empty key');
      return;
    }
    let id: string = `delete+${blob.id}+${this.count++}`;

    this.env.log.event(`S3: del start`, 1);

    let trace = new LogAbstract.AsyncTimer(this.env.log, 'S3: del', 1);
    let params = { Bucket: this.blobBucket(blob), Key: blob.id };
    let rq = new S3Request(blob);
    this.delBlobIndex[id] = rq;
    blob.setDeleting();
    rq.req = this.s3.deleteObject(params, (err: any, data: any) => {
        if (err)
          rq.err = err;
        else
          rq.data = data;
        rq.res = this;

        blob.endDelete(rq);
        this.emit('del', blob);

        delete this.delBlobIndex[id];

        trace.log();
        this.env.log.event(`S3: del done`, 1);
      });
  }

  ls(blob: Storage.StorageBlob, continuationToken?: string): void
  {
    let b = this.blobBucket(blob);
    if (b == '')
    {
      this.env.log.error('S3: blob ls called with empty bucket');
      return;
    }
    let id: string = `ls+${b}+${this.count++}`;

    this.env.log.event(`S3: ls start`, 1);

    let trace = new LogAbstract.AsyncTimer(this.env.log, 'S3: ls', 1);
    let params: any = { Bucket: b };
    if (continuationToken)
      params.ContinuationToken = continuationToken;
    let rq = new S3Request(blob);
    this.lsBlobIndex[id] = rq;
    blob.setListing();
    rq.req = this.s3.listObjectsV2(params, (err: any, data: any) => {
        if (err)
          rq.err = err;
        else
          rq.data = data;
        rq.res = this;

        blob.setListed();
        blob.endList(rq);
        this.emit('ls', blob);

        delete this.lsBlobIndex[id];

        trace.log();
        this.env.log.event(`S3: ls done`, 1);
      });
  }

  createTransferUrl(params: Storage.TransferParams): Storage.FsmTransferUrl
  {
    let fsm = new FsmTransferUrl(this.env, this.lookupBucket('transfers'), params);
    if (fsm === null)
    {
      let params: any = { Bucket: fsm.bucket, Fields: { key: fsm.key } };
      this.s3.createPresignedPost(params, (err: any, url: string) => {
          if (err)
          {
            this.env.log.error(`S3: createPresignedPost failed: ${err}`);
            fsm.setState(FSM.FSM_ERROR);
          }
          else
          {
            fsm.url = url;
            fsm.setState(FSM.FSM_DONE);
          }
        });
    }
    else
    {
      let s3params: any = { Bucket: fsm.bucket, Key: fsm.key };
      if (params.op === 'putObject') s3params.ContentType = fsm.params.contentType;
      this.s3.getSignedUrl(params.op, s3params, (err: any, url: string) => {
          if (err)
          {
            this.env.log.error(`S3: getSignedUrl failed: ${err}`);
            fsm.setState(FSM.FSM_ERROR);
          }
          else
          {
            fsm.url = url;
            fsm.setState(FSM.FSM_DONE);
          }
        });
    }
    return fsm;
  }
}
