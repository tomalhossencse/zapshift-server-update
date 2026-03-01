const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SCREET);

const port = process.env.PORT || 3000;

const crypto = require("crypto");

const admin = require("firebase-admin");

const serviceAccount = require("./zapshift-update-fb-sdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const generateTrackingId = () => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const random = crypto.randomBytes(3).toString("hex").toUpperCase();

  return `ZAP-${date}-${random}`;
};

// middleware
app.use(express.json());
app.use(cors());

// verify with fbtoken

const verifyFbToken = async (req, res, next) => {
  // console.log("header in middlewares : ", req.headers.authorization);
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized acces" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    // console.log("decode in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vybtxro.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection

    // db and collections
    const db = client.db("zapShiftUpdate");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const userCollection = db.collection("users");
    const riderCollection = db.collection("riders");

    // users related apis

    app.get("/users", verifyFbToken, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createAt = new Date();
      const email = user.email;
      const userExist = await userCollection.findOne({ email });

      if (userExist) {
        return res.send({ message: "users exists" });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    // parcel apis

    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      const options = { sort: { createAt: -1 } };
      //   parcels?email=&
      const resullt = await parcelCollection.find(query, options).toArray();
      res.send(resullt);
    });

    // get single parcels

    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      const resullt = await parcelCollection.insertOne(parcel);
      res.send(resullt);
    });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const resullt = await parcelCollection.deleteOne(query);
      res.send(resullt);
    });

    // rider apis

    app.get("/riders", async (req, res) => {
      const query = {};
      const options = { sort: { createAt: -1 } };

      const status = req.query.status;
      if (status) {
        query.status = status;
      }
      const result = await riderCollection.find(query, options).toArray();
      res.send(result);
    });

    app.patch("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const status = req.body.status;
      const update = {
        $set: {
          status: status,
        },
      };
      const result = await riderCollection.updateOne(query, update);

      if (status === "approved") {
        const email = req.body.email;
        const userQuery = { email };
        const updateUser = {
          $set: { role: "rider" },
        };

        const userResult = await userCollection.updateOne(
          userQuery,
          updateUser,
        );

        // res.send(result);
      }

      res.send(result);
    });

    app.delete("/riders/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await riderCollection.deleteOne(query);

      res.send(result);
    });

    app.post("/riders", async (req, res) => {
      const rider = req.body;
      rider.status = "pending";
      rider.createAt = new Date();

      const result = await riderCollection.insertOne(rider);
      res.send(result);
    });

    // payment related apis

    app.post("/payment-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "BDT",
              unit_amount: amount,
              product_data: {
                name: `please pay for :  ${paymentInfo.parcelName}`,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      const session_id = req.query.session_id;
      const session = await stripe.checkout.sessions.retrieve(session_id);

      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };

      const paymentExist = await paymentCollection.findOne(query);

      // console.log(paymentExist);

      if (paymentExist) {
        return res.send({
          message: "payments exits",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;

        const query = { _id: new ObjectId(id) };

        const update = {
          $set: {
            paymentStatus: "paid",
            trackingId,
          },
        };

        const result = await parcelCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paidAt: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);
          res.send({
            success: true,
            modifyPayment: result,
            paymentInfo: resultPayment,
            trackingId: trackingId,
            transactionId: session.payment_intent,
          });
        }
      }

      // console.log("session retrive data :", session);

      res.send({ success: false });
    });

    // old

    // app.post("/create-checkout-session", async (req, res) => {
    //   const paymentInfo = req.body;
    //   const amount = parseInt(paymentInfo.cost) * 100;
    //   const session = await stripe.checkout.sessions.create({
    //     line_items: [
    //       {
    //         price_data: {
    //           currency: "BDT",
    //           unit_amount: amount,
    //           product_data: {
    //             name: paymentInfo.parcelName,
    //           },
    //         },
    //         quantity: 1,
    //       },
    //     ],

    //     customer_email: paymentInfo.senderEmail,
    //     metadata: {
    //       parcelId: paymentInfo.parcelId,
    //     },
    //     mode: "payment",
    //     success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
    //     cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
    //   });
    //   console.log(session);
    //   res.send({ url: session.url });
    // });

    // payment related apis

    app.get("/payments", verifyFbToken, async (req, res) => {
      const email = req.query.email;

      const query = {};

      if (email) {
        query.customerEmail = email;

        // cheack email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "Fibidden Access" });
        }
      }

      const result = await paymentCollection
        .find(query)
        .sort({ paidAt: -1 })
        .toArray();
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "❤️Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zapshift Server is Running..............");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
