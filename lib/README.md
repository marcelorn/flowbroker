# @dojot/flow-node

A NodeJS library that allows you to integrate your own node on Dojot's [FlowBroker](https://github.com/dojot/flowbroker).

## How to build your own node

1) You need to create a class that extends the `DataHandlerBase` class, this
class is the responsable by implements your node behavior. The following methods
__must be__ implemented:
  - getNodeRepresentationPath
  - getMetadata
  - getLocalesPath
  - handleMessage

2) Is necessary to create a `.html` file that describes your node. You can find how to create it using the [NodeRed documentation](https://nodered.org/docs/creating-nodes/). Dojot's FlowBroker uses the [NodeRed](https://nodered.org/) frontend.


3) You need to encapsulate your code into a docker container.

4) Publish your container in some public repository like [DockerHub](https://hub.docker.com/) or some private based on [DockerRegistry](https://docs.docker.com/registry).

5) Call the FlowBroker endpoint to add a new node. Please check the [FlowBroker documentation](https://dojot.github.io/flowbroker/apiary_latest.html) to check
how this endpoint works.

## Internationalisation

The method `getLocalesPath`  should return the full path (`myNode/locales` ), 
where there're __Message Catalog__ (`myNode/locales/__language__.json` ).

The locales directory must be in the same directory as the node’s .js file.
The __language__ part of the path identifies the language the corresponding files provide. Eg.: 'en-US'.

A example of content in a  __Message Catalog__:

```json 
{
     "myNode" : {
         "message1": "This is my first message",
         "message2": "This is my second message"
     }
 }
```

#### Using i18n messages 

##### Runtime 
The runtime part of a node can access messages using the RED._() function. For example:

```javascript 
console.log(RED._("myNode.message1"));
```

With namespace, the namespace will be the __id__ of node
```javascript 
console.log(RED._("__id__:myNode.message1"));
```

##### Editor 

Any HTML element provided in the node template can specify a data-i18n attribute to provide the message identify to use. For example:

```html 
<span data-i18n="myNode.label.foo"></span>

<input type="text" data-i18n="[placeholder]myNode.placeholder.foo">

<a href="#" data-i18n="[title]myNode.label.linkTitle;myNode.label.linkText"></a>
```

## Sample
A sample node is attached to this package to illustrate the steps described in
the previous section. It's a simple node that converts a Celcius temperature
measure into Kelvin.

### How to build

Build the docker image:
```sh
cd sampleNode
docker build -t <your dockerHub username>/kelvin .
```

Publish it on your DockerHub:
```sh
docker push <your dockerHub username>/kelvin
```

Acquire a Dojot's token:
```sh
curl -X POST http://127.0.0.1:8000/auth \
-H 'Content-Type:application/json' \
-d '{"username": "admin", "passwd" : "admin"}'
```

This command will return a JWT token, you need to store it on an environment
variable:
```sh
export JWT=<the value returned>
```

Add the Kelvin node to Dojot.
```sh
curl -H "Authorization: Bearer ${JWT}" http://localhost:8000/flows/v1/node -H 'content-type: application/json' -d '{"image": "<your dockerHub username>/kelvin:latest", "id":"kelvin"}'
```

Now the Kelvin node will be available on `converters` category into the FlowBroker Dojot's interface.

Note: the DockerHub use is optional, you can use a private docker registry instead.


